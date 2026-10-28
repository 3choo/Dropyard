// pkt-line framing (git's wire format): 4 hex length digits + payload.

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const FLUSH = encoder.encode('0000');
export const DELIM = encoder.encode('0001');

const MAX_PKT_DATA = 65516;
const MAX_BAND_DATA = MAX_PKT_DATA - 1;

export function pkt(data: string | Uint8Array): Uint8Array {
  const body = typeof data === 'string' ? encoder.encode(data) : data;
  if (body.length > MAX_PKT_DATA) throw new Error('pkt-line too long');
  const out = new Uint8Array(body.length + 4);
  out.set(encoder.encode((body.length + 4).toString(16).padStart(4, '0')));
  out.set(body, 4);
  return out;
}

/** Wraps data in side-band-64k packets on the given band (1 data, 2 progress, 3 error). */
export function sideband(band: 1 | 2 | 3, data: string | Uint8Array): Uint8Array[] {
  const body = typeof data === 'string' ? encoder.encode(data) : data;
  const out: Uint8Array[] = [];
  for (let i = 0; i < body.length || (i === 0 && body.length === 0); i += MAX_BAND_DATA) {
    const part = body.subarray(i, i + MAX_BAND_DATA);
    const framed = new Uint8Array(part.length + 1);
    framed[0] = band;
    framed.set(part, 1);
    out.push(pkt(framed));
    if (body.length === 0) break;
  }
  return out;
}

export type Pkt = { kind: 'data'; data: Uint8Array; text: string } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'end' };

/** Parses every pkt-line in a fully buffered request body. */
export function parsePkts(buf: Uint8Array): { pkts: Pkt[]; rest: Uint8Array } {
  const pkts: Pkt[] = [];
  let pos = 0;
  while (pos + 4 <= buf.length) {
    const len = parseInt(decoder.decode(buf.subarray(pos, pos + 4)), 16);
    if (!Number.isFinite(len)) throw new Error('malformed pkt-line');
    if (len === 0) pkts.push({ kind: 'flush' });
    else if (len === 1) pkts.push({ kind: 'delim' });
    else if (len === 2) pkts.push({ kind: 'end' });
    else if (len < 4) throw new Error('malformed pkt-line');
    if (len < 4) {
      pos += 4;
      continue;
    }
    if (pos + len > buf.length) break;
    const data = buf.subarray(pos + 4, pos + len);
    pkts.push({ kind: 'data', data, text: decoder.decode(data).replace(/\n$/, '') });
    pos += len;
  }
  return { pkts, rest: buf.subarray(pos) };
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
