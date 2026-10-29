// Starter download: a git bundle of the whole repository that the browser can
// download with resume (HTTP Range), for first clones too big to survive one
// long upload-pack response. The pack is never stored: R2 blobs are framed as
// stored zlib blocks, so every byte offset is computable from sizes alone.
// Preparing it only fingerprints the pack (adler32 per blob, SHA-1 trailer) in
// resumable steps; the download then re-frames blobs straight from R2.

import { randomId } from '../lib/ids';
import { STORED_BLOCK as BLOCK, adler32, adlerTrailer, encodeInMemory, entryHeader, storedBlockHeader } from './packwrite';
import { collectPack } from './protocol';
import { toHex } from './objects';
import { listRefs } from './repo';
import { Sha1, type Sha1State } from './sha1';
import { GitStore } from './store';
import { concatBytes } from './pkt';
import { getBucket } from '../lib/storage';

const CHUNK_BLOCKS = 64; // ~4 MB per R2 range read
const WHOLE_MAX = 4 * 1024 * 1024;
const STEP_MS = 20_000;
const STEP_BYTES = 3 * 1024 * 1024 * 1024;
const LEASE_MS = 90_000;

type BlobRef = [key: string, size: number];

type Manifest = { id: string; headLen: number; blobs: BlobRef[] };

export type StarterState = {
  id: string;
  status: 'building' | 'ready' | 'failed';
  head: string | null;
  refs: number;
  createdAt: number;
  createdBy: string;
  headLen: number;
  blobCount: number;
  bytesTotal: number;
  bytesDone: number;
  cursor: number;
  blobOffset: number;
  adler: number;
  adlers: number[];
  sha: Sha1State | null;
  size: number;
  trailer: string | null;
  error: string | null;
  leaseUntil: number;
};

export class StarterError extends Error {}

const stateKey = (pid: string) => `p/${pid}/starter/state.json`;
const manifestKey = (pid: string, id: string) => `p/${pid}/starter/${id}/manifest.json`;
const headKey = (pid: string, id: string) => `p/${pid}/starter/${id}/head.bin`;

const enc = new TextEncoder();

function blockCount(size: number): number {
  return size === 0 ? 1 : Math.ceil(size / BLOCK);
}

/** Bytes before the first stored block: pack entry header plus the zlib header. */
function preludeOf(size: number): Uint8Array {
  return concatBytes([entryHeader('blob', size), Uint8Array.from([0x78, 0x01])]);
}

function encodedSize(size: number): number {
  return preludeOf(size).length + size + 5 * blockCount(size) + 4;
}

/** Stored-deflate framing of blocks [first, …) taken from `data`, which starts at block `first`. */
function frame(data: Uint8Array, first: number, size: number): Uint8Array {
  const total = blockCount(size);
  const n = size === 0 ? 1 : Math.ceil(data.length / BLOCK);
  const out = new Uint8Array(data.length + 5 * n);
  let o = 0;
  for (let k = 0; k < n; k++) {
    const piece = data.subarray(k * BLOCK, (k + 1) * BLOCK);
    out.set(storedBlockHeader(piece.length, first + k === total - 1), o);
    out.set(piece, o + 5);
    o += piece.length + 5;
  }
  return out;
}

async function readRange(bucket: R2Bucket, key: string, offset: number, length: number): Promise<Uint8Array> {
  if (length === 0) return new Uint8Array();
  const obj = await bucket.get(key, { range: { offset, length } });
  if (!obj) throw new StarterError(`A stored file is missing (${key})`);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  if (bytes.length !== length) throw new StarterError(`A stored file has the wrong size (${key})`);
  return bytes;
}

export async function getStarter(bucket: R2Bucket, pid: string): Promise<StarterState | null> {
  const obj = await bucket.get(stateKey(pid));
  return obj ? ((await obj.json()) as StarterState) : null;
}

async function saveState(bucket: R2Bucket, pid: string, state: StarterState): Promise<void> {
  await bucket.put(stateKey(pid), JSON.stringify(state), { httpMetadata: { contentType: 'application/json' } });
}

export function presentStarter(s: StarterState | null) {
  if (!s) return null;
  return {
    id: s.id,
    status: s.status,
    head: s.head,
    refs: s.refs,
    createdAt: s.createdAt,
    files: s.blobCount,
    filesDone: s.cursor,
    bytesTotal: s.bytesTotal,
    bytesDone: s.bytesDone,
    size: s.status === 'ready' ? s.size : null,
    error: s.error,
  };
}

/** Snapshot every ref, write the bundle header and small objects, and queue the blobs. */
export async function startStarter(env: Env, pid: string, defaultBranch: string, userId: string): Promise<StarterState> {
  const bucket = getBucket(env);
  const previous = await getStarter(bucket, pid);
  if (previous?.status === 'building' && previous.leaseUntil > Date.now()) {
    throw new StarterError('A starter download is already being prepared');
  }
  const store = new GitStore(env, pid);
  const refs = (await listRefs(env.DB, pid)).filter((r) => r.name.startsWith('refs/heads/') || r.name.startsWith('refs/tags/'));
  if (refs.length === 0) throw new StarterError('This repository is empty');
  const head = refs.find((r) => r.name === `refs/heads/${defaultBranch}`)?.sha ?? null;

  const entries = await collectPack(store, refs.map((r) => r.sha), []);
  const small: Uint8Array[] = [];
  const blobs: BlobRef[] = [];
  for (const e of entries) {
    if ('key' in e) blobs.push([e.key, e.size]);
    else for (const chunk of encodeInMemory(e.type, e.data, e.compress)) small.push(chunk);
  }

  const lines = ['# v2 git bundle'];
  if (head) lines.push(`${head} HEAD`);
  for (const r of refs) lines.push(`${r.sha} ${r.name}`);
  const bundleHeader = enc.encode(`${lines.join('\n')}\n\n`);
  const packHeader = new Uint8Array(12);
  packHeader.set([0x50, 0x41, 0x43, 0x4b, 0, 0, 0, 2]);
  new DataView(packHeader.buffer).setUint32(8, entries.length);
  const packStart = concatBytes([packHeader, ...small]);
  const headBin = concatBytes([bundleHeader, packStart]);

  const id = randomId(10);
  await bucket.put(headKey(pid, id), headBin);
  const manifest: Manifest = { id, headLen: headBin.length, blobs };
  await bucket.put(manifestKey(pid, id), JSON.stringify(manifest), { httpMetadata: { contentType: 'application/json' } });
  if (previous && previous.id !== id) await bucket.delete([headKey(pid, previous.id), manifestKey(pid, previous.id)]);

  const state: StarterState = {
    id,
    status: 'building',
    head,
    refs: refs.length,
    createdAt: Date.now(),
    createdBy: userId,
    headLen: headBin.length,
    blobCount: blobs.length,
    bytesTotal: blobs.reduce((s, b) => s + b[1], 0),
    bytesDone: 0,
    cursor: 0,
    blobOffset: 0,
    adler: 1,
    adlers: [],
    sha: new Sha1().update(packStart).save(),
    size: 0,
    trailer: null,
    error: null,
    leaseUntil: 0,
  };
  await saveState(bucket, pid, state);
  return state;
}

async function loadManifest(bucket: R2Bucket, pid: string, id: string): Promise<Manifest> {
  const obj = await bucket.get(manifestKey(pid, id));
  if (!obj) throw new StarterError('The starter download is incomplete; prepare it again');
  return (await obj.json()) as Manifest;
}

/** Fingerprint blobs for up to ~20 s; returns the updated state. */
export async function starterStep(env: Env, pid: string, maxBytes = STEP_BYTES): Promise<StarterState> {
  const bucket = getBucket(env);
  const state = await getStarter(bucket, pid);
  if (!state) throw new StarterError('No starter download has been started');
  if (state.status !== 'building') return state;
  if (state.leaseUntil > Date.now()) return state; // another tab is working on it
  state.leaseUntil = Date.now() + LEASE_MS;
  await saveState(bucket, pid, state);

  try {
    const manifest = await loadManifest(bucket, pid, state.id);
    const sha = new Sha1(state.sha!);
    const started = Date.now();
    let budget = maxBytes;
    const whole = new Map<number, Promise<Uint8Array>>();
    let ahead = state.cursor;
    const prefetch = () => {
      while (ahead < manifest.blobs.length && ahead - state.cursor < 16) {
        const [key, size] = manifest.blobs[ahead]!;
        if (size > WHOLE_MAX) break;
        if (!(ahead === state.cursor && state.blobOffset > 0)) whole.set(ahead, readRange(bucket, key, 0, size));
        ahead++;
      }
    };

    while (state.cursor < manifest.blobs.length && Date.now() - started < STEP_MS && budget > 0) {
      const [key, size] = manifest.blobs[state.cursor]!;
      if (state.blobOffset === 0) sha.update(preludeOf(size));
      prefetch();
      const pending = whole.get(state.cursor);
      if (pending || size === 0) {
        const data = size === 0 ? new Uint8Array() : await pending!;
        whole.delete(state.cursor);
        state.adler = adler32(state.adler, data);
        sha.update(frame(data, 0, size));
        state.bytesDone += size;
        budget -= size;
      } else {
        const length = Math.min(CHUNK_BLOCKS * BLOCK, size - state.blobOffset);
        const data = await readRange(bucket, key, state.blobOffset, length);
        state.adler = adler32(state.adler, data);
        sha.update(frame(data, state.blobOffset / BLOCK, size));
        state.blobOffset += length;
        state.bytesDone += length;
        budget -= length;
        if (state.blobOffset < size) continue;
      }
      sha.update(adlerTrailer(state.adler));
      state.adlers.push(state.adler);
      state.cursor++;
      state.blobOffset = 0;
      state.adler = 1;
      if (ahead < state.cursor) ahead = state.cursor;
    }

    if (state.cursor >= manifest.blobs.length) {
      const trailer = sha.digest();
      state.trailer = toHex(trailer);
      state.size = state.headLen + manifest.blobs.reduce((s, b) => s + encodedSize(b[1]), 0) + 20;
      state.status = 'ready';
      state.sha = null;
    } else {
      state.sha = sha.save();
    }
  } catch (err) {
    state.status = 'failed';
    state.error = err instanceof StarterError ? err.message : 'Preparing the download failed';
    console.error('starter step failed', err);
  }
  state.leaseUntil = 0;
  await saveState(bucket, pid, state);
  return state;
}

/** Parses a single "bytes=a-b" range; null means serve the whole file. */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return 'invalid';
  let start: number;
  let end: number;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (start > end || start >= size) return 'invalid';
  return { start, end };
}

/** Bytes [start, end] of the bundle, inclusive, regenerated from R2. */
export async function starterStream(bucket: R2Bucket, pid: string, state: StarterState, start: number, end: number): Promise<ReadableStream<Uint8Array>> {
  const manifest = await loadManifest(bucket, pid, state.id);
  const offsets = new Float64Array(manifest.blobs.length + 1);
  offsets[0] = state.headLen;
  for (let i = 0; i < manifest.blobs.length; i++) offsets[i + 1] = offsets[i]! + encodedSize(manifest.blobs[i]![1]);
  const trailer = Uint8Array.from(state.trailer!.match(/../g)!.map((h) => parseInt(h, 16)));
  const gen = generate(bucket, pid, state, manifest, offsets, trailer, start, end + 1);
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

async function* generate(
  bucket: R2Bucket,
  pid: string,
  state: StarterState,
  manifest: Manifest,
  offsets: Float64Array,
  trailer: Uint8Array,
  from: number,
  to: number,
): AsyncGenerator<Uint8Array> {
  let pos = from;
  if (pos < state.headLen) {
    const stop = Math.min(to, state.headLen);
    yield await readRange(bucket, headKey(pid, state.id), pos, stop - pos);
    pos = stop;
  }

  // First blob that ends after pos.
  let lo = 0;
  let hi = manifest.blobs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid + 1]! <= pos) lo = mid + 1;
    else hi = mid;
  }

  const whole = new Map<number, Promise<Uint8Array>>();
  let ahead = lo;
  for (let i = lo; i < manifest.blobs.length && pos < to; i++) {
    while (ahead < manifest.blobs.length && ahead - i < 16 && offsets[ahead]! < to) {
      const [key, size] = manifest.blobs[ahead]!;
      if (size <= WHOLE_MAX) whole.set(ahead, readRange(bucket, key, 0, size));
      ahead++;
    }
    const [key, size] = manifest.blobs[i]!;
    const base = offsets[i]!;
    const prelude = preludeOf(size);
    const dataStart = base + prelude.length;
    const blocks = blockCount(size);
    const tailStart = dataStart + size + 5 * blocks;
    const clip = (bytes: Uint8Array, at: number): Uint8Array | null => {
      const s = Math.max(pos, at);
      const e = Math.min(to, at + bytes.length);
      return s < e ? bytes.subarray(s - at, e - at) : null;
    };

    const pre = clip(prelude, base);
    if (pre) {
      yield pre;
      pos += pre.length;
    }
    if (pos < tailStart && pos < to) {
      const pending = whole.get(i);
      if (pending || size === 0) {
        const data = size === 0 ? new Uint8Array() : await pending!;
        const out = clip(frame(data, 0, size), dataStart);
        if (out) {
          yield out;
          pos += out.length;
        }
      } else {
        let block = Math.floor((pos - dataStart) / (BLOCK + 5));
        while (block < blocks && pos < to) {
          const count = Math.min(CHUNK_BLOCKS, blocks - block);
          const offset = block * BLOCK;
          const length = Math.min(count * BLOCK, size - offset);
          const data = await readRange(bucket, key, offset, length);
          const out = clip(frame(data, block, size), dataStart + block * (BLOCK + 5));
          if (out) {
            yield out;
            pos += out.length;
          }
          block += count;
        }
      }
    }
    whole.delete(i);
    if (pos < to) {
      const tail = clip(adlerTrailer(state.adlers[i]!), tailStart);
      if (tail) {
        yield tail;
        pos += tail.length;
      }
    }
  }
  if (pos < to) {
    const t = clip2(trailer, offsets[manifest.blobs.length]!, pos, to);
    if (t) yield t;
  }
}

function clip2(bytes: Uint8Array, at: number, pos: number, to: number): Uint8Array | null {
  const s = Math.max(pos, at);
  const e = Math.min(to, at + bytes.length);
  return s < e ? bytes.subarray(s - at, e - at) : null;
}
