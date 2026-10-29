// Streams a packfile (clone/fetch) built from stored objects. Large blobs are
// framed as stored (uncompressed) zlib blocks so a multi-GB clone costs little
// CPU; small text objects are deflated.

import { createHash } from 'node:crypto';
import { zlibSync } from 'fflate';
import { TYPE_CODE, type ObjType } from './objects';

export type PackEntry =
  | { type: ObjType; data: Uint8Array; compress: boolean }
  | { type: 'blob'; size: number; key: string; compress: boolean };

const MB = 1024 * 1024;
const PREFETCH_MAX = 2 * MB;
const COMPRESS_MAX = 4 * MB;
const AHEAD_ENTRIES = 48;
const AHEAD_BYTES = 32 * MB;
export const STORED_BLOCK = 65535;

/** The 5-byte header of one stored deflate block of `len` bytes. */
export function storedBlockHeader(len: number, final: boolean): Uint8Array {
  return Uint8Array.from([final ? 1 : 0, len & 0xff, len >> 8, ~len & 0xff, (~len >> 8) & 0xff]);
}

/** The zlib trailer: the adler32 checksum, big-endian. */
export function adlerTrailer(a: number): Uint8Array {
  return Uint8Array.from([(a >>> 24) & 0xff, (a >>> 16) & 0xff, (a >>> 8) & 0xff, a & 0xff]);
}

export function entryHeader(type: ObjType, size: number): Uint8Array {
  const bytes: number[] = [];
  let b = (TYPE_CODE[type] << 4) | (size & 0x0f);
  let rest = Math.floor(size / 16);
  while (rest > 0) {
    bytes.push(b | 0x80);
    b = rest & 0x7f;
    rest = Math.floor(rest / 128);
  }
  bytes.push(b);
  return Uint8Array.from(bytes);
}

export function adler32(prev: number, data: Uint8Array): number {
  let a = prev & 0xffff;
  let b = prev >>> 16;
  let i = 0;
  while (i < data.length) {
    const end = Math.min(i + 5552, data.length);
    for (; i < end; i++) {
      a += data[i]!;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Frames bytes as a zlib stream of stored deflate blocks, chunk by chunk. */
class StoredZlib {
  private adler = 1;
  private remaining: number;
  constructor(total: number) {
    this.remaining = total;
  }
  start(): Uint8Array {
    return Uint8Array.from([0x78, 0x01]);
  }
  *blocks(chunk: Uint8Array): Generator<Uint8Array> {
    this.adler = adler32(this.adler, chunk);
    for (let i = 0; i < chunk.length; i += STORED_BLOCK) {
      const piece = chunk.subarray(i, i + STORED_BLOCK);
      this.remaining -= piece.length;
      const out = new Uint8Array(piece.length + 5);
      out.set(storedBlockHeader(piece.length, this.remaining === 0));
      out.set(piece, 5);
      yield out;
    }
  }
  finish(): Uint8Array {
    if (this.remaining !== 0) throw new Error('stored object length mismatch');
    return adlerTrailer(this.adler);
  }
}

const EMPTY_STORED = Uint8Array.from([0x78, 0x01, 0x01, 0x00, 0x00, 0xff, 0xff, 0x00, 0x00, 0x00, 0x01]);

export function* encodeInMemory(type: ObjType, data: Uint8Array, compress: boolean): Generator<Uint8Array> {
  yield entryHeader(type, data.length);
  if (data.length === 0) {
    yield EMPTY_STORED;
    return;
  }
  if (compress && data.length <= COMPRESS_MAX) {
    yield zlibSync(data, { level: 6 });
    return;
  }
  const z = new StoredZlib(data.length);
  yield z.start();
  yield* z.blocks(data);
  yield z.finish();
}

type Fetched = Uint8Array | ReadableStream<Uint8Array>;

export function packStream(bucket: R2Bucket, entries: PackEntry[]): ReadableStream<Uint8Array> {
  const gen = packGenerator(bucket, entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await gen.next();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await gen.return(undefined);
    },
  });
}

async function* packGenerator(bucket: R2Bucket, entries: PackEntry[]): AsyncGenerator<Uint8Array> {
  const hasher = createHash('sha1');
  const emit = (chunk: Uint8Array): Uint8Array => {
    hasher.update(chunk);
    return chunk;
  };

  const header = new Uint8Array(12);
  header.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(header.buffer).setUint32(8, entries.length);
  yield emit(header);

  const ahead = new Map<number, Promise<Fetched>>();
  let next = 0;
  let aheadBytes = 0;
  const fill = (current: number) => {
    while (next < entries.length && next - current < AHEAD_ENTRIES && aheadBytes < AHEAD_BYTES) {
      const e = entries[next]!;
      if ('key' in e) {
        if (e.size > PREFETCH_MAX) {
          if (next > current) break; // open big objects only when reached
          ahead.set(next, openObject(bucket, e.key));
        } else {
          aheadBytes += e.size;
          ahead.set(
            next,
            bucket.get(e.key).then(async (obj) => {
              if (!obj) throw new Error(`stored object ${e.key} missing`);
              return new Uint8Array(await obj.arrayBuffer());
            }),
          );
        }
      }
      next++;
    }
  };

  for (let i = 0; i < entries.length; i++) {
    fill(i);
    const e = entries[i]!;
    if (!('key' in e)) {
      for (const chunk of encodeInMemory(e.type, e.data, e.compress)) yield emit(chunk);
      continue;
    }
    if (!ahead.has(i)) {
      ahead.set(i, e.size > PREFETCH_MAX ? openObject(bucket, e.key) : bucket.get(e.key).then(async (obj) => {
        if (!obj) throw new Error(`stored object ${e.key} missing`);
        return new Uint8Array(await obj.arrayBuffer());
      }));
    }
    const fetched = await ahead.get(i)!;
    ahead.delete(i);
    if (fetched instanceof Uint8Array) {
      aheadBytes -= e.size;
      if (fetched.length !== e.size) throw new Error(`stored object ${e.key} has the wrong size`);
      for (const chunk of encodeInMemory('blob', fetched, e.compress)) yield emit(chunk);
      continue;
    }
    yield emit(entryHeader('blob', e.size));
    const z = new StoredZlib(e.size);
    yield emit(z.start());
    const reader = fetched.getReader();
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const block of z.blocks(value)) yield emit(block);
      }
    } finally {
      reader.releaseLock();
    }
    yield emit(z.finish());
  }
  yield hasher.digest();
}

async function openObject(bucket: R2Bucket, key: string): Promise<ReadableStream<Uint8Array>> {
  const obj = await bucket.get(key);
  if (!obj) throw new Error(`stored object ${key} missing`);
  return obj.body;
}
