// SHA-1 whose state can be saved between requests, so the checksum of a
// multi-GB pack can be computed in resumable steps (node:crypto hashes cannot
// be serialized).

export type Sha1State = { h: number[]; buf: string; total: number };

const W = new Int32Array(80);

export class Sha1 {
  private h: Int32Array;
  private buf = new Uint8Array(64);
  private bufLen = 0;
  private total = 0;

  constructor(state?: Sha1State) {
    this.h = Int32Array.from(state?.h ?? [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    if (state) {
      const saved = Uint8Array.from(atob(state.buf), (ch) => ch.charCodeAt(0));
      this.buf.set(saved);
      this.bufLen = saved.length;
      this.total = state.total;
    }
  }

  save(): Sha1State {
    let s = '';
    for (let i = 0; i < this.bufLen; i++) s += String.fromCharCode(this.buf[i]!);
    return { h: Array.from(this.h), buf: btoa(s), total: this.total };
  }

  update(data: Uint8Array): this {
    this.total += data.length;
    let i = 0;
    if (this.bufLen > 0) {
      const take = Math.min(64 - this.bufLen, data.length);
      this.buf.set(data.subarray(0, take), this.bufLen);
      this.bufLen += take;
      i = take;
      if (this.bufLen < 64) return this;
      this.block(this.buf, 0);
      this.bufLen = 0;
    }
    for (; i + 64 <= data.length; i += 64) this.block(data, i);
    if (i < data.length) {
      this.buf.set(data.subarray(i), 0);
      this.bufLen = data.length - i;
    }
    return this;
  }

  digest(): Uint8Array {
    const bits = this.total * 8;
    const pad = new Uint8Array((this.bufLen < 56 ? 56 : 120) - this.bufLen + 8);
    pad[0] = 0x80;
    const view = new DataView(pad.buffer);
    view.setUint32(pad.length - 8, Math.floor(bits / 0x100000000));
    view.setUint32(pad.length - 4, bits >>> 0);
    this.update(pad);
    const out = new Uint8Array(20);
    const ov = new DataView(out.buffer);
    for (let k = 0; k < 5; k++) ov.setInt32(k * 4, this.h[k]!);
    return out;
  }

  private block(d: Uint8Array, o: number): void {
    for (let t = 0; t < 16; t++) {
      const p = o + t * 4;
      W[t] = (d[p]! << 24) | (d[p + 1]! << 16) | (d[p + 2]! << 8) | d[p + 3]!;
    }
    for (let t = 16; t < 80; t++) {
      const x = W[t - 3]! ^ W[t - 8]! ^ W[t - 14]! ^ W[t - 16]!;
      W[t] = (x << 1) | (x >>> 31);
    }
    const h = this.h;
    let a = h[0]!;
    let b = h[1]!;
    let c = h[2]!;
    let d3 = h[3]!;
    let e = h[4]!;
    for (let t = 0; t < 80; t++) {
      let f: number;
      let k: number;
      if (t < 20) {
        f = (b & c) | (~b & d3);
        k = 0x5a827999;
      } else if (t < 40) {
        f = b ^ c ^ d3;
        k = 0x6ed9eba1;
      } else if (t < 60) {
        f = (b & c) | (b & d3) | (c & d3);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d3;
        k = 0xca62c1d6;
      }
      const temp = (((a << 5) | (a >>> 27)) + f + e + k + W[t]!) | 0;
      e = d3;
      d3 = c;
      c = (b << 30) | (b >>> 2);
      b = a;
      a = temp;
    }
    h[0] = (h[0]! + a) | 0;
    h[1] = (h[1]! + b) | 0;
    h[2] = (h[2]! + c) | 0;
    h[3] = (h[3]! + d3) | 0;
    h[4] = (h[4]! + e) | 0;
  }
}
