// Reads an incoming packfile (git push) into the object store, resolving
// OFS_DELTA / REF_DELTA objects, streaming large blobs straight to R2.

import { createHash } from 'node:crypto';
import { randomId } from '../lib/ids';
import { applyDelta, deltaSizes, memoryBase, rangedBase, type BaseSource } from './delta';
import { CODE_TYPE, hashObject, objectHeader, toHex, type ObjType } from './objects';
import { GitStore, INLINE_MAX, objectKey, type ObjectMeta } from './store';
import { ByteReader, inflateToBuffer, inflateZlib } from './stream';
import { getBucket } from '../lib/storage';

const BUFFER_MAX = 8 * 1024 * 1024;
const MAX_DELTA = 96 * 1024 * 1024;
const CACHE_BUDGET = 48 * 1024 * 1024;

type Written = { type: ObjType; size: number; key: string | null };

export type PackResult = { objects: Map<string, ObjType> };

class DataCache {
  private map = new Map<string, Uint8Array>();
  private bytes = 0;
  set(sha: string, data: Uint8Array): void {
    if (data.length > 1024 * 1024 || this.map.has(sha)) return;
    this.map.set(sha, data);
    this.bytes += data.length;
    while (this.bytes > CACHE_BUDGET) {
      const [k, v] = this.map.entries().next().value!;
      this.map.delete(k);
      this.bytes -= v.length;
    }
  }
  get(sha: string): Uint8Array | undefined {
    return this.map.get(sha);
  }
}

export async function readPack(reader: ByteReader, store: GitStore): Promise<PackResult> {
  const objects = new Map<string, ObjType>();
  const first = await reader.next();
  if (!first) return { objects };
  reader.unshift(first);

  const start = reader.position;
  const header = await reader.readExact(12);
  if (String.fromCharCode(...header.subarray(0, 4)) !== 'PACK') throw new Error('not a packfile');
  const view = new DataView(header.buffer, header.byteOffset, 12);
  const version = view.getUint32(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = view.getUint32(8);

  const written = new Map<string, Written>();
  const byOffset = new Map<number, string>();
  const cache = new DataCache();
  const bucket = getBucket(store.env);
  const deferred: { offset: number; base: string; delta: Uint8Array }[] = [];

  const stored = async (sha: string): Promise<Written | null> => {
    const w = written.get(sha);
    if (w) return w;
    const meta: ObjectMeta | null = await store.meta(sha);
    return meta ? { type: meta.type, size: meta.size, key: meta.r2_key } : null;
  };

  const record = (offset: number, sha: string, w: Written) => {
    byOffset.set(offset, sha);
    objects.set(sha, w.type);
    if (!written.has(sha)) written.set(sha, w);
  };

  /** Stores a fully buffered object. */
  const storeBuffered = async (offset: number, type: ObjType, data: Uint8Array): Promise<string> => {
    const sha = await hashObject(type, data);
    cache.set(sha, data);
    if (!(await stored(sha))) {
      await store.putObject(sha, type, data);
      written.set(sha, { type, size: data.length, key: type === 'blob' || data.length > INLINE_MAX ? objectKey(store.projectId, sha) : null });
    }
    record(offset, sha, (await stored(sha))!);
    return sha;
  };

  /** Streams a large blob into R2 under a temporary-named key, hashing as it goes. */
  const storeStreamed = async (
    offset: number,
    size: number,
    produce: (write: (chunk: Uint8Array) => Promise<void>) => Promise<void>,
  ): Promise<string> => {
    const key = `p/${store.projectId}/git/u/${randomId(12)}`;
    const { readable, writable } = new FixedLengthStream(size);
    const put = bucket.put(key, readable);
    const writer = writable.getWriter();
    const hasher = createHash('sha1').update(objectHeader('blob', size));
    try {
      await produce(async (chunk) => {
        hasher.update(chunk);
        await writer.write(chunk);
      });
      await writer.close();
    } catch (err) {
      await writer.abort(err).catch(() => {});
      await put.catch(() => {});
      throw err;
    }
    await put;
    const sha = hasher.digest('hex');
    if (await stored(sha)) {
      await bucket.delete(key);
    } else {
      store.queueIndex(sha, 'blob', size, key, null);
      written.set(sha, { type: 'blob', size, key });
    }
    record(offset, sha, (await stored(sha))!);
    return sha;
  };

  const baseFor = async (sha: string): Promise<{ type: ObjType; src: BaseSource } | null> => {
    const hit = cache.get(sha);
    const w = await stored(sha);
    if (!w) return null;
    if (hit) return { type: w.type, src: memoryBase(hit) };
    if (w.key) {
      const key = w.key;
      if (w.size <= BUFFER_MAX) {
        const obj = await bucket.get(key);
        if (!obj) throw new Error(`delta base ${sha} missing from storage`);
        const data = new Uint8Array(await obj.arrayBuffer());
        cache.set(sha, data);
        return { type: w.type, src: memoryBase(data) };
      }
      return {
        type: w.type,
        src: rangedBase(w.size, async (o, l) => {
          const obj = await bucket.get(key, { range: { offset: o, length: l } });
          if (!obj) throw new Error(`delta base ${sha} missing from storage`);
          return new Uint8Array(await obj.arrayBuffer());
        }),
      };
    }
    await store.flush();
    const obj = await store.load(sha);
    if (!obj) return null;
    return { type: obj.type, src: memoryBase(obj.data) };
  };

  const resolveDelta = async (offset: number, baseSha: string, delta: Uint8Array): Promise<boolean> => {
    const base = await baseFor(baseSha);
    if (!base) return false;
    const { resultSize } = deltaSizes(delta);
    if (base.type === 'blob' && resultSize > BUFFER_MAX) {
      await storeStreamed(offset, resultSize, (write) => applyDelta(delta, base.src, write).then(() => {}));
    } else {
      const out = new Uint8Array(resultSize);
      let o = 0;
      await applyDelta(delta, base.src, (chunk) => {
        out.set(chunk, o);
        o += chunk.length;
      });
      await storeBuffered(offset, base.type, out);
    }
    return true;
  };

  for (let i = 0; i < count; i++) {
    const offset = reader.position - start;
    let byte = await reader.readByte();
    const typeCode = (byte >> 4) & 7;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = await reader.readByte();
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeCode === 6) {
      byte = await reader.readByte();
      let rel = byte & 0x7f;
      while (byte & 0x80) {
        byte = await reader.readByte();
        rel = (rel + 1) * 128 + (byte & 0x7f);
      }
      if (size > MAX_DELTA) throw new Error('delta too large');
      const delta = await inflateToBuffer(reader, size);
      const baseSha = byOffset.get(offset - rel);
      if (!baseSha) throw new Error('OFS_DELTA base not found in pack');
      if (!(await resolveDelta(offset, baseSha, delta))) throw new Error('OFS_DELTA base unreadable');
    } else if (typeCode === 7) {
      const baseSha = toHex(await reader.readExact(20));
      if (size > MAX_DELTA) throw new Error('delta too large');
      const delta = await inflateToBuffer(reader, size);
      if (!(await resolveDelta(offset, baseSha, delta))) deferred.push({ offset, base: baseSha, delta });
    } else {
      const type = CODE_TYPE[typeCode];
      if (!type) throw new Error(`unknown pack object type ${typeCode}`);
      if (type === 'blob' && size > BUFFER_MAX) {
        await storeStreamed(offset, size, async (write) => {
          let got = 0;
          await inflateZlib(reader, async (chunk) => {
            got += chunk.length;
            if (got > size) throw new Error('pack object larger than declared');
            await write(chunk);
          });
          if (got !== size) throw new Error('pack object shorter than declared');
        });
      } else {
        await storeBuffered(offset, type, await inflateToBuffer(reader, size));
      }
    }
  }

  while (deferred.length > 0) {
    let progressed = false;
    for (let i = 0; i < deferred.length; i++) {
      const d = deferred[i]!;
      if (await resolveDelta(d.offset, d.base, d.delta)) {
        deferred.splice(i--, 1);
        progressed = true;
      }
    }
    if (!progressed) throw new Error(`missing delta base ${deferred[0]!.base}`);
  }

  await reader.readExact(20); // pack trailer checksum
  await store.flush();
  return { objects };
}
