/**
 * CompressionEngine — COMPRESSÃO LOSSLESS EM DUAS CAMADAS
 * --------------------------------------------------------
 * CAMADA A (estrutural, reversível): reorganização dos bytes sem tocar no
 * conteúdo — shuffle/transpose por registro (ex. 50 bytes do STL binário).
 * CAMADA B (estatística): DEFLATE/gzip sobre o resultado.
 *
 * NÍVEL A — BYTE LOSSLESS: descompactado tem bytes idênticos (SHA-256 igual).
 * NÍVEL B — GEOMETRY LOSSLESS: geometria idêntica, representação pode mudar
 * (ex. STL ASCII → binário). Sempre sinalizado explicitamente.
 *
 * SMART: testa N estratégias, verifica a vencedora por descompressão real
 * e só então a coroa. Se a meta de tamanho não for atingível, entrega o
 * melhor lossless — NUNCA toca na malha para forçar número.
 */

import type { FormatInfo } from './formats';
import { bytesEqual } from './sha256';

export type CompressionLevel = 'fast' | 'balanced' | 'max';
/** A = byte-lossless · B = geometry-lossless (representação muda). */
export type LosslessTier = 'A' | 'B';
export type DeflateFormat = 'deflate' | 'gzip';
export type MethodId = 'store' | 'deflate' | 'gzip';

export interface TransformSpec {
  /** 'none' | 'shuffle:<stride>:<start>:<fullRows>:<remainder>' */
  id: string;
}

export interface StrategyOutcome {
  method: MethodId;
  tier: LosslessTier;
  transform: TransformSpec;
  payload: Uint8Array;
  ratio: number;
  elapsedMs: number;
}

export interface SmartResult {
  winner: StrategyOutcome;
  tried: Array<{ method: MethodId; transform: string; ratio: number; tier: LosslessTier }>;
  originalSize: number;
}

export function hasCompressionStreams(): boolean {
  return typeof CompressionStream !== 'undefined' && typeof DecompressionStream !== 'undefined';
}

// ---------------------------------------------------------------------------
// CAMADA A — shuffle/transpose reversível (byte plane grouping)
// ---------------------------------------------------------------------------

export function shuffleEncode(bytes: Uint8Array, start: number, stride: number, length: number): { data: Uint8Array; fullRows: number; remainder: number } {
  const region = bytes.subarray(start, start + length);
  const fullRows = Math.floor(region.length / stride);
  const remainder = region.length - fullRows * stride;
  const out = new Uint8Array(region.length);
  for (let plane = 0; plane < stride; plane += 1) {
    for (let row = 0; row < fullRows; row += 1) {
      out[plane * fullRows + row] = region[row * stride + plane];
    }
  }
  out.set(region.subarray(fullRows * stride), fullRows * stride);
  return { data: out, fullRows, remainder };
}

export function shuffleDecode(shuffled: Uint8Array, stride: number, fullRows: number): Uint8Array {
  const out = new Uint8Array(shuffled.length);
  for (let plane = 0; plane < stride; plane += 1) {
    for (let row = 0; row < fullRows; row += 1) {
      out[row * stride + plane] = shuffled[plane * fullRows + row];
    }
  }
  out.set(shuffled.subarray(fullRows * stride), fullRows * stride);
  void fullRows;
  return out;
}

// ---------------------------------------------------------------------------
// CAMADA B — DEFLATE/gzip por streaming (sem N cópias na memória)
// ---------------------------------------------------------------------------

const CHUNK = 256 * 1024;

async function pipeThrough(
  data: Uint8Array,
  stream: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let received = 0;
  const writer = stream.writable.getWriter();
  const reader = stream.readable.getReader();
  // Limpeza rigorosa: um inflate corrompido abandona o pump no meio do voo;
  // sem abort/cancel explícitos, recursos nativos (zlib) vazam e poluem
  // streams subsequentes no mesmo processo (Z_DATA_ERROR fantasma).
  const cleanup = async (): Promise<void> => {
    try {
      await writer.abort();
    } catch {
      /* já encerrado */
    }
    try {
      await reader.cancel();
    } catch {
      /* já encerrado */
    }
    try {
      writer.releaseLock();
    } catch {
      /* já liberado */
    }
    try {
      reader.releaseLock();
    } catch {
      /* já liberado */
    }
  };
  try {
    const pump = (async (): Promise<void> => {
      for (let offset = 0; offset < data.length; offset += CHUNK) {
        // Cópia por chunk: satisfaz BufferSource (ArrayBuffer) e evita reter
        // o buffer original inteiro no stream.
        await writer.write(new Uint8Array(data.subarray(offset, Math.min(data.length, offset + CHUNK))));
      }
      await writer.close();
    })();
    const readAll = (async (): Promise<void> => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength)));
        received += value.length;
      }
    })();
    await Promise.all([pump, readAll]);
  } finally {
    await cleanup();
  }
  const out = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

export async function deflateBytes(data: Uint8Array, format: DeflateFormat): Promise<Uint8Array> {
  return pipeThrough(data, new CompressionStream(format));
}

export async function inflateBytes(data: Uint8Array, format: DeflateFormat): Promise<Uint8Array> {
  return pipeThrough(data, new DecompressionStream(format));
}

// ---------------------------------------------------------------------------
// Estratégias + seleção inteligente
// ---------------------------------------------------------------------------

interface Candidate {
  method: MethodId;
  deflate: DeflateFormat | null;
  stride: number; // 0 = sem shuffle
  tier: LosslessTier;
}

function candidatesFor(info: FormatInfo, level: CompressionLevel): Candidate[] {
  const list: Candidate[] = [{ method: 'store', deflate: null, stride: 0, tier: 'A' }];
  if (!hasCompressionStreams()) return list;
  const push = (method: MethodId, deflate: DeflateFormat | null, stride: number): void => {
    if (list.some((c) => c.method === method && (c.deflate ?? '') === (deflate ?? '') && c.stride === stride)) return;
    list.push({ method, deflate, stride, tier: 'A' });
  };
  // Sempre: deflate direto (rápido e universal).
  push('deflate', 'deflate', 0);
  if (level === 'fast') return list;
  push('gzip', 'gzip', 0);
  // Shuffle pelo registro natural do formato (STL binário: 50 bytes).
  if (info.recordSize >= 4 && info.recordBytes > info.recordSize) {
    push('deflate', 'deflate', info.recordSize);
  }
  // Shuffle genérico (ajuda texto e floats fora de registro fixo).
  push('deflate', 'deflate', 8);
  if (level === 'max') {
    push('deflate', 'deflate', 4);
    push('gzip', 'gzip', 8);
    if (info.recordSize >= 4 && info.recordBytes > info.recordSize) {
      push('gzip', 'gzip', info.recordSize);
    }
    push('deflate', 'deflate', 16);
  }
  return list;
}

function transformId(stride: number, start: number): string {
  return stride > 0 ? `shuffle:${stride}:${start}` : 'none';
}

export function applyTransform(bytes: Uint8Array, info: FormatInfo, stride: number): { data: Uint8Array; id: string } {
  if (stride <= 0 || info.recordBytes <= stride) return { data: bytes, id: 'none' };
  const start = Math.max(0, info.recordStart);
  const length = Math.min(info.recordBytes, bytes.length - start);
  if (length <= stride) return { data: bytes, id: 'none' };
  const head = bytes.subarray(0, start);
  const tail = bytes.subarray(start + length);
  const { data } = shuffleEncode(bytes, start, stride, length);
  // data cobre [start, start+length); remonta sem copiar head/tail.
  const out = new Uint8Array(bytes.length);
  out.set(head, 0);
  out.set(data, start);
  out.set(tail, start + length);
  return { data: out, id: transformId(stride, start) };
}

export function invertTransform(data: Uint8Array, id: string, info: FormatInfo): Uint8Array {
  if (id === 'none') return data;
  const match = id.match(/^shuffle:(\d+):(\d+)$/);
  if (!match) throw new Error(`Transform desconhecido: ${id}.`);
  const stride = Number(match[1]);
  const start = Number(match[2]);
  const length = Math.min(info.recordBytes, data.length - start);
  const fullRows = Math.floor(length / stride);
  const region = shuffleDecode(data.subarray(start, start + length), stride, fullRows);
  const out = new Uint8Array(data.length);
  out.set(data.subarray(0, start), 0);
  out.set(region, start);
  out.set(data.subarray(start + length), start + length);
  return out;
}

export async function compressSmart(
  bytes: Uint8Array,
  info: FormatInfo,
  level: CompressionLevel,
  onStage?: (tried: number, total: number) => void,
): Promise<SmartResult> {
  const originalSize = bytes.length;
  const candidates = candidatesFor(info, level);
  const tried: SmartResult['tried'] = [];
  let winner: StrategyOutcome | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    onStage?.(i, candidates.length);
    const started = performance.now();
    const { data: transformed, id } = applyTransform(bytes, info, candidate.stride);
    let payload: Uint8Array;
    if (candidate.deflate) {
      payload = await deflateBytes(transformed, candidate.deflate);
    } else {
      payload = transformed;
    }
    const outcome: StrategyOutcome = {
      method: candidate.method,
      tier: 'A',
      transform: { id },
      payload,
      ratio: originalSize > 0 ? payload.length / originalSize : 1,
      elapsedMs: performance.now() - started,
    };
    tried.push({ method: outcome.method, transform: id, ratio: outcome.ratio, tier: 'A' });
    if (!winner || outcome.payload.length < winner.payload.length) winner = outcome;
  }
  if (!winner) throw new Error('Nenhuma estratégia disponível.');
  // Verificação da vencedora por descompressão REAL antes de coroar.
  const roundtrip = await decompressPayload(winner, info);
  if (!bytesEqual(roundtrip, bytes)) {
    throw new Error('LOSSLESS_VALIDATION_FAILED: a vencedora não reconstrói o original.');
  }
  onStage?.(candidates.length, candidates.length);
  return { winner, tried, originalSize };
}

export async function decompressPayload(outcome: StrategyOutcome, info: FormatInfo): Promise<Uint8Array> {
  let data = outcome.payload;
  if (outcome.method === 'deflate') data = await inflateBytes(data, 'deflate');
  else if (outcome.method === 'gzip') data = await inflateBytes(data, 'gzip');
  else if (outcome.method !== 'store') throw new Error(`Método desconhecido: ${outcome.method}.`);
  return invertTransform(data, outcome.transform.id, info);
}
