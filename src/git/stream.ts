// Pull-based byte reader over a request body, plus a zlib stream decoder that
// stops exactly at the end of each compressed object (packfiles concatenate
// zlib streams with no length prefix).

import { Inflate } from 'fflate';

export class ByteReader {
  private queue: Uint8Array[] = [];
  private eof = false;
  /** Bytes handed out so far (net of anything pushed back). */
  position = 0;

  constructor(private readonly source: ReadableStreamDefaultReader<Uint8Array>) {}

  static from(body: ReadableStream<Uint8Array> | null): ByteReader {
    const stream = body ?? new ReadableStream<Uint8Array>({ start: (c) => c.close() });
    return new ByteReader(stream.getReader());
  }

  /** Next available chunk (any size), or null at end of input. */
  async next(): Promise<Uint8Array | null> {
    while (this.queue.length === 0) {
      if (this.eof) return null;
      const { value, done } = await this.source.read();
      if (done) this.eof = true;
      else if (value && value.length > 0) this.queue.push(value);
    }
    const chunk = this.queue.shift()!;
    this.position += chunk.length;
    return chunk;
  }

  unshift(chunk: Uint8Array): void {
    if (chunk.length === 0) return;
    this.queue.unshift(chunk);
    this.position -= chunk.length;
  }

  async readExact(n: number): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = await this.next();
      if (!chunk) throw new Error('unexpected end of pack data');
      const take = Math.min(n - filled, chunk.length);
      out.set(chunk.subarray(0, take), filled);
      filled += take;
      if (take < chunk.length) this.unshift(chunk.subarray(take));
    }
    return out;
  }

  async readByte(): Promise<number> {
    return (await this.readExact(1))[0]!;
  }

  async rest(): Promise<Uint8Array[]> {
    const out: Uint8Array[] = [];
    for (let c = await this.next(); c; c = await this.next()) out.push(c);
    return out;
  }
}

// fflate's streaming inflater exposes no "consumed bytes" count; its state
// object does: f = final block seen, l = inside a block, p = bit position
// into the unconsumed buffer p.
type InflateState = { f?: number; l?: unknown; p?: number };
type InflateInternals = { s: InflateState; p: Uint8Array };

/**
 * Inflates one zlib stream from the reader, handing output chunks to sink in
 * order. Leaves the reader positioned right after the stream's checksum.
 */
export async function inflateZlib(
  reader: ByteReader,
  sink: (chunk: Uint8Array) => Promise<void> | void,
): Promise<number> {
  const header = await reader.readExact(2);
  if ((header[0]! & 0x0f) !== 8 || ((header[0]! << 8) | header[1]!) % 31 !== 0 || header[1]! & 0x20) {
    throw new Error('bad zlib header in pack');
  }
  let produced = 0;
  const out: Uint8Array[] = [];
  const inflater = new Inflate((chunk) => {
    if (chunk.length > 0) out.push(chunk);
  });
  const internals = inflater as unknown as InflateInternals;
  for (;;) {
    const chunk = await reader.next();
    if (!chunk) throw new Error('unexpected end of pack data inside an object');
    inflater.push(chunk, false);
    for (const piece of out.splice(0)) {
      produced += piece.length;
      await sink(piece);
    }
    const st = internals.s;
    if (st.f && !st.l) {
      const leftover = internals.p.subarray((st.p ?? 0) & 7 ? 1 : 0);
      reader.unshift(leftover.slice());
      await reader.readExact(4); // adler32; object content is verified by its sha
      return produced;
    }
  }
}

export async function inflateToBuffer(reader: ByteReader, expected: number): Promise<Uint8Array> {
  const buf = new Uint8Array(expected);
  let o = 0;
  await inflateZlib(reader, (chunk) => {
    if (o + chunk.length > expected) throw new Error('pack object larger than declared');
    buf.set(chunk, o);
    o += chunk.length;
  });
  if (o !== expected) throw new Error('pack object shorter than declared');
  return buf;
}
