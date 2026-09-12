/**
 * Container .3dpack (v1) + saída .gz universal
 * ---------------------------------------------
 * .3dpack armazena: formato original, metadados, payload comprimido, hash
 * SHA-256 do original, algoritmo e versão. A descompressão reconstrói o
 * arquivo original e RECUSA entregar bytes cujo hash difira (FAIL).
 *
 * Layout:
 *   0..7    magic "3DPACK01"
 *   8..11   u32 LE: tamanho do header JSON
 *   12..    header JSON (utf-8)
 *   ...     payload (conforme header.method/transform)
 */

import type { MeshFileFormat } from './formats';
import type { LosslessTier, MethodId } from './engine';
import { decompressPayload, deflateBytes, inflateBytes } from './engine';
import type { StrategyOutcome } from './engine';
import type { FormatInfo } from './formats';
import { bytesEqual, sha256Hex } from './sha256';

export const PACK_MAGIC = '3DPACK01';
export const PACK_VERSION = 1;

export interface PackHeader {
  v: number;
  format: MeshFileFormat;
  tier: LosslessTier;
  originalName: string;
  originalSize: number;
  originalSha256: string;
  faces: number;
  method: MethodId;
  transform: string;
  createdBy: string;
}

export interface PackedFile {
  bytes: Uint8Array;
  header: PackHeader;
  payloadSize: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function pack3d(
  original: Uint8Array,
  originalName: string,
  info: FormatInfo,
  outcome: StrategyOutcome,
): PackedFile {
  const header: PackHeader = {
    v: PACK_VERSION,
    format: info.format,
    tier: outcome.tier,
    originalName,
    originalSize: original.length,
    originalSha256: sha256Hex(original),
    faces: info.faces,
    method: outcome.method,
    transform: outcome.transform.id,
    createdBy: 'redutor-3d-compressor/1.0',
  };
  const headerBytes = encoder.encode(JSON.stringify(header));
  const out = new Uint8Array(8 + 4 + headerBytes.length + outcome.payload.length);
  encoder.encodeInto(PACK_MAGIC, out.subarray(0, 8));
  new DataView(out.buffer, out.byteOffset, out.byteLength).setUint32(8, headerBytes.length, true);
  out.set(headerBytes, 12);
  out.set(outcome.payload, 12 + headerBytes.length);
  return { bytes: out, header, payloadSize: outcome.payload.length };
}

export function parsePackHeader(packed: Uint8Array): { header: PackHeader; payload: Uint8Array } {
  if (packed.length < 12) throw new Error('Arquivo .3dpack inválido (curto demais).');
  const magic = decoder.decode(packed.subarray(0, 8));
  if (magic !== PACK_MAGIC) throw new Error('Magic inválido: não é um .3dpack.');
  const headerLength = new DataView(packed.buffer, packed.byteOffset, packed.byteLength).getUint32(8, true);
  if (12 + headerLength > packed.length) throw new Error('Header .3dpack corrompido.');
  const header = JSON.parse(decoder.decode(packed.subarray(12, 12 + headerLength))) as PackHeader;
  if (header.v !== PACK_VERSION) throw new Error(`Versão .3dpack não suportada: ${header.v}.`);
  return { header, payload: packed.subarray(12 + headerLength) };
}

/**
 * Descompacta e VALIDA: tamanho + SHA-256 precisam conferir, senão FAIL —
 * o arquivo comprimido é descartado e nada é entregue como "lossless".
 */
export async function unpack3d(packed: Uint8Array, infoForTransform: FormatInfo): Promise<{ bytes: Uint8Array; header: PackHeader }> {
  const { header, payload } = parsePackHeader(packed);
  const outcome: StrategyOutcome = {
    method: header.method,
    tier: header.tier,
    transform: { id: header.transform },
    payload,
    ratio: payload.length / Math.max(1, header.originalSize),
    elapsedMs: 0,
  };
  const bytes = await decompressPayload(outcome, infoForTransform);
  if (bytes.length !== header.originalSize) {
    throw new Error(`LOSSLESS_VALIDATION_FAILED: tamanho divergente (${bytes.length} ≠ ${header.originalSize}).`);
  }
  if (sha256Hex(bytes) !== header.originalSha256) {
    throw new Error('LOSSLESS_VALIDATION_FAILED: SHA-256 divergente após descompressão.');
  }
  return { bytes, header };
}

/** Saída universal .gz (gzip sobre os bytes originais, tier A). */
export async function packGzip(original: Uint8Array): Promise<Uint8Array> {
  return deflateBytes(original, 'gzip');
}

export async function unpackGzip(data: Uint8Array): Promise<Uint8Array> {
  return inflateBytes(data, 'gzip');
}

/** Confere se dois buffers são idênticos (bytes + hash). */
export function assertIdentical(a: Uint8Array, b: Uint8Array, label: string): { sha256: string } {
  if (!bytesEqual(a, b)) throw new Error(`LOSSLESS_VALIDATION_FAILED (${label}): bytes divergentes.`);
  const expected = sha256Hex(a);
  const actual = sha256Hex(b);
  if (expected !== actual) throw new Error(`LOSSLESS_VALIDATION_FAILED (${label}): SHA-256 divergente.`);
  return { sha256: actual };
}
