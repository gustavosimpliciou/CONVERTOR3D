/**
 * SHA-256 puro em TypeScript (sem dependências).
 *
 * Motivo: `crypto.subtle` exige contexto seguro (https/localhost) e não
 * existe em todos os ambientes onde o Worker roda. Este implementation
 * funciona em qualquer lugar — navegador, Worker, Node — e sustenta a
 * regra LOSSLESS: SHA256(original) == SHA256(descompactado), ou FAIL.
 *
 * API incremental (streaming): cria o hasher, alimenta com chunks e
 * finaliza. Evita cópias extras de arquivos grandes na memória.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
  private h0 = 0x6a09e667;
  private h1 = 0xbb67ae85;
  private h2 = 0x3c6ef372;
  private h3 = 0xa54ff53a;
  private h4 = 0x510e527f;
  private h5 = 0x9b05688c;
  private h6 = 0x1f83d9ab;
  private h7 = 0x5be0cd19;
  private buffer = new Uint8Array(64);
  private buffered = 0;
  private length = 0;
  private finalized = false;

  update(data: Uint8Array): this {
    if (this.finalized) throw new Error('Hasher já finalizado.');
    let offset = 0;
    this.length += data.length;
    if (this.buffered > 0) {
      const take = Math.min(64 - this.buffered, data.length);
      this.buffer.set(data.subarray(0, take), this.buffered);
      this.buffered += take;
      offset = take;
      if (this.buffered === 64) {
        this.compress(this.buffer, 0);
        this.buffered = 0;
      }
    }
    while (offset + 64 <= data.length) {
      this.compress(data, offset);
      offset += 64;
    }
    if (offset < data.length) {
      this.buffer.set(data.subarray(offset), 0);
      this.buffered = data.length - offset;
    }
    return this;
  }

  digest(): Uint8Array {
    if (this.finalized) throw new Error('Hasher já finalizado.');
    this.finalized = true;
    const bitLengthHi = Math.floor(this.length / 0x20000000);
    const bitLengthLo = (this.length << 3) >>> 0;
    this.buffer[this.buffered] = 0x80;
    this.buffered += 1;
    if (this.buffered > 56) {
      this.buffer.fill(0, this.buffered, 64);
      this.compress(this.buffer, 0);
      this.buffered = 0;
    }
    this.buffer.fill(0, this.buffered, 56);
    const view = new DataView(this.buffer.buffer, this.buffer.byteOffset, 64);
    view.setUint32(56, bitLengthHi >>> 0, false);
    view.setUint32(60, bitLengthLo >>> 0, false);
    this.compress(this.buffer, 0);
    const out = new Uint8Array(32);
    const outView = new DataView(out.buffer);
    outView.setUint32(0, this.h0 >>> 0, false);
    outView.setUint32(4, this.h1 >>> 0, false);
    outView.setUint32(8, this.h2 >>> 0, false);
    outView.setUint32(12, this.h3 >>> 0, false);
    outView.setUint32(16, this.h4 >>> 0, false);
    outView.setUint32(20, this.h5 >>> 0, false);
    outView.setUint32(24, this.h6 >>> 0, false);
    outView.setUint32(28, this.h7 >>> 0, false);
    return out;
  }

  digestHex(): string {
    return Array.from(this.digest(), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  private compress(data: Uint8Array, offset: number): void {
    const w = new Uint32Array(64);
    for (let i = 0; i < 16; i += 1) {
      w[i] =
        ((data[offset + i * 4] << 24) |
          (data[offset + i * 4 + 1] << 16) |
          (data[offset + i * 4 + 2] << 8) |
          data[offset + i * 4 + 3]) >>>
        0;
    }
    for (let i = 16; i < 64; i += 1) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = [this.h0, this.h1, this.h2, this.h3, this.h4, this.h5, this.h6, this.h7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + s1 + ch + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    this.h0 = (this.h0 + a) >>> 0;
    this.h1 = (this.h1 + b) >>> 0;
    this.h2 = (this.h2 + c) >>> 0;
    this.h3 = (this.h3 + d) >>> 0;
    this.h4 = (this.h4 + e) >>> 0;
    this.h5 = (this.h5 + f) >>> 0;
    this.h6 = (this.h6 + g) >>> 0;
    this.h7 = (this.h7 + h) >>> 0;
  }
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}

/** SHA-256 de uma vez (conveniência para arquivos pequenos/médios). */
export function sha256Hex(data: Uint8Array): string {
  return new Sha256().update(data).digestHex();
}

/** Igualdade byte-a-byte (a prova definitiva de lossless, além do hash). */
export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  // Comparação em blocos de 32 bits para arquivos grandes.
  const words = Math.floor(a.length / 4);
  const a32 = new Uint32Array(a.buffer, a.byteOffset, words);
  const b32 = new Uint32Array(b.buffer, b.byteOffset, b.byteLength >= words * 4 ? words : 0);
  for (let i = 0; i < words; i += 1) {
    if (a32[i] !== b32[i]) return false;
  }
  for (let i = words * 4; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
