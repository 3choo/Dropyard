// Git delta (OFS_DELTA / REF_DELTA payload) decoding.

export type BaseSource = { size: number; read(offset: number, length: number): Promise<Uint8Array> };

export function memoryBase(data: Uint8Array): BaseSource {
  return { size: data.length, read: async (offset, length) => data.subarray(offset, offset + length) };
}

const BLOCK = 4 * 1024 * 1024;
const MAX_BLOCKS = 6;

/** Random access to a large stored base through cached ranged reads. */
export function rangedBase(size: number, readRange: (offset: number, length: number) => Promise<Uint8Array>): BaseSource {
  const blocks = new Map<number, Promise<Uint8Array>>();
  const block = (n: number): Promise<Uint8Array> => {
    let hit = blocks.get(n);
    if (hit) {
      blocks.delete(n);
      blocks.set(n, hit);
      return hit;
    }
    hit = readRange(n * BLOCK, Math.min(BLOCK, size - n * BLOCK));
    blocks.set(n, hit);
    while (blocks.size > MAX_BLOCKS) blocks.delete(blocks.keys().next().value!);
    return hit;
  };
  return {
    size,
    async read(offset, length) {
      const out = new Uint8Array(length);
      let o = 0;
      while (o < length) {
        const pos = offset + o;
        const n = Math.floor(pos / BLOCK);
        const data = await block(n);
        const start = pos - n * BLOCK;
        const take = Math.min(length - o, data.length - start);
        if (take <= 0) throw new Error('delta copy beyond base');
        out.set(data.subarray(start, start + take), o);
        o += take;
      }
      return out;
    },
  };
}

function readVarint(delta: Uint8Array, pos: number): [number, number] {
  let value = 0;
  let shift = 0;
  let byte: number;
  do {
    byte = delta[pos++]!;
    value += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  } while (byte & 0x80);
  return [value, pos];
}

export function deltaSizes(delta: Uint8Array): { baseSize: number; resultSize: number; start: number } {
  const [baseSize, p1] = readVarint(delta, 0);
  const [resultSize, p2] = readVarint(delta, p1);
  return { baseSize, resultSize, start: p2 };
}

const FLUSH_AT = 1024 * 1024;

export async function applyDelta(
  delta: Uint8Array,
  base: BaseSource,
  sink: (chunk: Uint8Array) => Promise<void> | void,
): Promise<number> {
  const { baseSize, resultSize, start } = deltaSizes(delta);
  if (baseSize !== base.size) throw new Error('delta base size mismatch');
  let pos = start;
  let produced = 0;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  const emit = async (chunk: Uint8Array) => {
    pending.push(chunk);
    pendingBytes += chunk.length;
    produced += chunk.length;
    if (pendingBytes >= FLUSH_AT) {
      const out = pending;
      pending = [];
      pendingBytes = 0;
      for (const c of out) await sink(c);
    }
  };
  while (pos < delta.length) {
    const op = delta[pos++]!;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) offset |= delta[pos++]!;
      if (op & 0x02) offset |= delta[pos++]! << 8;
      if (op & 0x04) offset |= delta[pos++]! << 16;
      if (op & 0x08) offset += delta[pos++]! * 0x1000000;
      if (op & 0x10) size |= delta[pos++]!;
      if (op & 0x20) size |= delta[pos++]! << 8;
      if (op & 0x40) size |= delta[pos++]! << 16;
      if (size === 0) size = 0x10000;
      if (offset + size > base.size) throw new Error('delta copy out of range');
      await emit((await base.read(offset, size)).slice());
    } else if (op) {
      if (pos + op > delta.length) throw new Error('delta insert out of range');
      await emit(delta.slice(pos, pos + op));
      pos += op;
    } else {
      throw new Error('invalid delta opcode');
    }
  }
  for (const c of pending) await sink(c);
  if (produced !== resultSize) throw new Error('delta result size mismatch');
  return produced;
}
