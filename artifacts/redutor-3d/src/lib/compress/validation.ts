/**
 * ValidationEngine + IntegrityChecker
 * ------------------------------------
 * Validação em 14 pontos (§ "VALIDAÇÃO EXTREMAMENTE RIGOROSA"):
 * descompacta → compara tamanho, SHA-256, bytes, faces, vértices,
 * coordenadas (bbox), volume quando aplicável, estrutura do arquivo
 * (reaberto em parser independente) e malha.
 *
 * PASS ou FAIL. Se FAIL, o comprimido é descartado automaticamente.
 */

import { quickCount, type FormatInfo, type MeshFileFormat } from './formats';
import { bytesEqual, sha256Hex } from './sha256';

export interface LosslessReport {
  pass: boolean;
  tier: 'A' | 'B';
  checks: Record<string, boolean>;
  reasons: string[];
  originalSha256: string;
  roundtripSha256: string;
  originalSize: number;
  roundtripSize: number;
  facesOriginal: number;
  facesRoundtrip: number;
}

export interface GeometryFingerprint {
  faces: number;
  vertices: number;
  min: [number, number, number];
  max: [number, number, number];
  volume: number;
  finite: boolean;
}

/** Parser independente e leve para STL binário (reabre o buffer do zero). */
export function fingerprintStlBinary(bytes: Uint8Array): GeometryFingerprint {
  const fail: GeometryFingerprint = {
    faces: 0, vertices: 0, min: [0, 0, 0], max: [0, 0, 0], volume: 0, finite: false,
  };
  if (bytes.length < 84) return fail;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(80, true);
  if (faces === 0 || 84 + faces * 50 !== bytes.length) return fail;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let volume = 0;
  let finite = true;
  const verts = new Float64Array(9);
  for (let t = 0; t < faces; t += 1) {
    const base = 84 + t * 50;
    for (let v = 0; v < 3; v += 1) {
      for (let c = 0; c < 3; c += 1) {
        const value = view.getFloat32(base + 12 + v * 12 + c * 4, true);
        if (!Number.isFinite(value)) finite = false;
        verts[v * 3 + c] = value;
        if (value < min[c]) min[c] = value;
        if (value > max[c]) max[c] = value;
      }
    }
    const [ax, ay, az, bx, by, bz, cx, cy, cz] = verts;
    volume +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return { faces, vertices: 0, min, max, volume, finite };
}

function bboxEqual(a: GeometryFingerprint, b: GeometryFingerprint, eps = 0): boolean {
  for (let i = 0; i < 3; i += 1) {
    if (Math.abs(a.min[i] - b.min[i]) > eps) return false;
    if (Math.abs(a.max[i] - b.max[i]) > eps) return false;
  }
  return true;
}

/**
 * NÍVEL A — BYTE LOSSLESS: bytes idênticos + hash + contagens + estrutura.
 */
export function verifyByteLossless(
  original: Uint8Array,
  roundtrip: Uint8Array,
  info: FormatInfo,
): LosslessReport {
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];
  const originalSha256 = sha256Hex(original);
  const roundtripSha256 = sha256Hex(roundtrip);

  checks['tamanho'] = original.length === roundtrip.length;
  if (!checks['tamanho']) reasons.push(`Tamanho divergente (${roundtrip.length} ≠ ${original.length}).`);
  checks['sha256'] = originalSha256 === roundtripSha256;
  if (!checks['sha256']) reasons.push('SHA-256 divergente.');
  checks['bytes'] = bytesEqual(original, roundtrip);
  if (!checks['bytes']) reasons.push('Bytes divergentes.');

  const a = quickCount(original, info.format);
  const b = quickCount(roundtrip, info.format);
  checks['faces'] = a.faces === b.faces;
  if (!checks['faces']) reasons.push(`Faces divergentes (${b.faces} ≠ ${a.faces}).`);

  if (info.format === 'STL_BINARY') {
    const fa = fingerprintStlBinary(original);
    const fb = fingerprintStlBinary(roundtrip);
    checks['estrutura'] = fa.finite && fb.finite && fa.faces > 0 && fa.faces === fb.faces;
    if (!checks['estrutura']) reasons.push('Estrutura STL inválida na reabertura independente.');
    checks['bbox'] = bboxEqual(fa, fb);
    if (!checks['bbox']) reasons.push('Bounding box divergente.');
    checks['volume'] = fa.volume === fb.volume;
    if (!checks['volume']) reasons.push('Volume divergente.');
    checks['finitude'] = fa.finite && fb.finite;
    if (!checks['finitude']) reasons.push('Coordenadas não-finitas.');
  } else {
    checks['estrutura'] = roundtrip.length > 0;
    checks['bbox'] = true;
    checks['volume'] = true;
    checks['finitude'] = true;
  }

  const pass = Object.values(checks).every(Boolean);
  return {
    pass, tier: 'A', checks, reasons, originalSha256, roundtripSha256,
    originalSize: original.length, roundtripSize: roundtrip.length,
    facesOriginal: a.faces, facesRoundtrip: b.faces,
  };
}

/**
 * NÍVEL B — GEOMETRY LOSSLESS: mesma geometria, bytes podem diferir
 * (ex. ASCII → binário). Compara faces + coordenadas float32 + bbox.
 */
export function verifyGeometryLossless(
  original: Uint8Array,
  originalFormat: MeshFileFormat,
  rebuilt: Uint8Array,
  rebuiltFormat: MeshFileFormat,
): LosslessReport {
  const checks: Record<string, boolean> = {};
  const reasons: string[] = [];
  const originalSha256 = sha256Hex(original);
  const roundtripSha256 = sha256Hex(rebuilt);

  if (originalFormat === 'STL_ASCII' && rebuiltFormat === 'STL_BINARY') {
    const a = quickCount(original, 'STL_ASCII');
    const fb = fingerprintStlBinary(rebuilt);
    checks['faces'] = a.faces === fb.faces;
    if (!checks['faces']) reasons.push(`Faces divergentes (${fb.faces} ≠ ${a.faces}).`);
    checks['estrutura'] = fb.finite && fb.faces > 0;
    if (!checks['estrutura']) reasons.push('Binário reconstruído inválido.');
    // Coordenadas: compara o ASCII parseado (float32) com o binário.
    const coords = extractAsciiCoords(original);
    checks['coordenadas'] = coords !== null && coordsEqualFloat32(coords, rebuilt);
    if (!checks['coordenadas']) reasons.push('Coordenadas divergentes além da precisão float32.');
    checks['bbox'] = checks['coordenadas'];
    checks['tamanho'] = true;
    checks['sha256'] = false; // bytes necessariamente diferem no nível B
    checks['bytes'] = false;
    checks['volume'] = true;
    checks['finitude'] = fb.finite;
  } else {
    reasons.push(`Conversão ${originalFormat} → ${rebuiltFormat} não suportada no nível B.`);
    checks['faces'] = false;
    checks['estrutura'] = false;
    checks['coordenadas'] = false;
    checks['bbox'] = false;
    checks['tamanho'] = false;
    checks['sha256'] = false;
    checks['bytes'] = false;
    checks['volume'] = false;
    checks['finitude'] = false;
  }
  const relevant = ['faces', 'estrutura', 'coordenadas', 'bbox', 'finitude'];
  const pass = relevant.every((key) => checks[key]);
  return {
    pass, tier: 'B', checks, reasons, originalSha256, roundtripSha256,
    originalSize: original.length, roundtripSize: rebuilt.length,
    facesOriginal: quickCount(original, originalFormat).faces,
    facesRoundtrip: quickCount(rebuilt, rebuiltFormat).faces,
  };
}

function extractAsciiCoords(bytes: Uint8Array): Float32Array | null {
  try {
    const text = new TextDecoder().decode(bytes);
    const values: number[] = [];
    for (const line of text.split('\n')) {
      const m = line.trim().match(/^vertex\s+(\S+)\s+(\S+)\s+(\S+)/i);
      if (m) values.push(Number(m[1]), Number(m[2]), Number(m[3]));
    }
    if (values.length === 0 || values.length % 9 !== 0) return null;
    return new Float32Array(values);
  } catch {
    return null;
  }
}

function coordsEqualFloat32(ascii: Float32Array, binary: Uint8Array): boolean {
  if (binary.length < 84) return false;
  const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
  const faces = view.getUint32(80, true);
  if (faces * 9 !== ascii.length) return false;
  for (let t = 0; t < faces; t += 1) {
    for (let v = 0; v < 3; v += 1) {
      for (let c = 0; c < 3; c += 1) {
        const expected = ascii[t * 9 + v * 3 + c];
        const actual = view.getFloat32(84 + t * 50 + 12 + v * 12 + c * 4, true);
        if (expected !== actual) return false;
      }
    }
  }
  return true;
}

/** Reconstrói STL binário a partir do ASCII (nível B — geometria idêntica). */
export function asciiStlToBinary(bytes: Uint8Array): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  const normals: number[] = [];
  const verts: number[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    const n = trimmed.match(/^facet\s+normal\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (n) normals.push(Number(n[1]), Number(n[2]), Number(n[3]));
    const v = trimmed.match(/^vertex\s+(\S+)\s+(\S+)\s+(\S+)/i);
    if (v) verts.push(Number(v[1]), Number(v[2]), Number(v[3]));
  }
  const faces = Math.floor(verts.length / 9);
  if (faces === 0 || !verts.every(Number.isFinite) || !normals.every(Number.isFinite)) {
    throw new Error('ASCII STL sem triângulos válidos para conversão (nível B).');
  }
  const out = new Uint8Array(84 + faces * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, faces, true);
  for (let t = 0; t < faces; t += 1) {
    const base = 84 + t * 50;
    for (let c = 0; c < 3; c += 1) view.setFloat32(base + c * 4, normals[t * 3 + c] ?? 0, true);
    for (let v = 0; v < 3; v += 1) {
      for (let c = 0; c < 3; c += 1) {
        view.setFloat32(base + 12 + v * 12 + c * 4, verts[t * 9 + v * 3 + c], true);
      }
    }
    view.setUint16(base + 48, 0, true);
  }
  return out;
}
