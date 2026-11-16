// Incremental SHA-1. The annotation server identifies files by
// sha1(contents)[:16] (see _file_id in server.py); computing the same id in
// the browser lets us ask whether the server already has a file before
// uploading it. crypto.subtle can't be used: it only exists on HTTPS or
// localhost pages, and it can't hash a large file incrementally.
export class Sha1 {
  constructor() {
    this.h = new Uint32Array([0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0]);
    this.block = new Uint8Array(64);
    this.blockLen = 0;
    this.totalLen = 0;
    this.w = new Uint32Array(80);
  }

  update(data) {
    let i = 0;
    this.totalLen += data.length;
    if (this.blockLen > 0) {
      const take = Math.min(64 - this.blockLen, data.length);
      this.block.set(data.subarray(0, take), this.blockLen);
      this.blockLen += take;
      i = take;
      if (this.blockLen < 64) return;
      this._compress(this.block, 0);
      this.blockLen = 0;
    }
    for (; i + 64 <= data.length; i += 64) this._compress(data, i);
    if (i < data.length) {
      this.block.set(data.subarray(i), 0);
      this.blockLen = data.length - i;
    }
  }

  digestHex() {
    const bitLen = this.totalLen * 8;
    const pad = new Uint8Array(((this.blockLen < 56 ? 56 : 120) - this.blockLen) + 8);
    pad[0] = 0x80;
    const n = pad.length;
    // 64-bit big-endian length; split since JS bit ops are 32-bit.
    const hi = Math.floor(bitLen / 0x100000000), lo = bitLen >>> 0;
    pad[n - 8] = hi >>> 24; pad[n - 7] = hi >>> 16; pad[n - 6] = hi >>> 8; pad[n - 5] = hi;
    pad[n - 4] = lo >>> 24; pad[n - 3] = lo >>> 16; pad[n - 2] = lo >>> 8; pad[n - 1] = lo;
    const total = this.totalLen;
    this.update(pad);
    this.totalLen = total;
    return Array.from(this.h, x => x.toString(16).padStart(8, '0')).join('');
  }

  _compress(bytes, o) {
    const w = this.w;
    for (let t = 0; t < 16; t++, o += 4) {
      w[t] = (bytes[o] << 24) | (bytes[o + 1] << 16) | (bytes[o + 2] << 8) | bytes[o + 3];
    }
    for (let t = 16; t < 80; t++) {
      const x = w[t - 3] ^ w[t - 8] ^ w[t - 14] ^ w[t - 16];
      w[t] = (x << 1) | (x >>> 31);
    }
    let [a, b, c, d, e] = this.h;
    for (let t = 0; t < 80; t++) {
      let f, k;
      if (t < 20)      { f = (b & c) | (~b & d);        k = 0x5a827999; }
      else if (t < 40) { f = b ^ c ^ d;                 k = 0x6ed9eba1; }
      else if (t < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else             { f = b ^ c ^ d;                 k = 0xca62c1d6; }
      const tmp = (((a << 5) | (a >>> 27)) + f + e + k + w[t]) | 0;
      e = d; d = c; c = (b << 30) | (b >>> 2); b = a; a = tmp;
    }
    const h = this.h;
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e;
  }
}
