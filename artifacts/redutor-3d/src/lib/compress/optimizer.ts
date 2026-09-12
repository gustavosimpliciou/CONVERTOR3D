/**
 * RepresentationOptimizer + CompressionBenchmark
 * -----------------------------------------------
 * Encontra a MENOR representação VÁLIDA com a MESMA extensão do original
 * (.stl → .stl, .obj → .obj), sem reduzir faces nem tocar na geometria.
 *
 * Métodos testados internamente (benchmark real, não estimativa):
 *  - STL binário → passthrough byte-lossless (binário já é 84+50N; com o
 *    mesmo N, válido ⇒ mesmo tamanho — redução maior exigiria quebrar o
 *    formato, o que é proibido);
 *  - STL ASCII → binário (GEOMETRY PRESERVING CONVERSION, nível B);
 *  - OBJ → normalização de texto sem tocar em dígitos (nível B);
 *  - outros formatos → passthrough byte-lossless + mensagem honesta.
 *
 * Regras: cada candidato é REIMPORTADO e comparado (faces, bbox, volume,
 * área, centroide, normais, topologia, superfície). Só o menor APROVADO é
 * entregue. Se nada melhorar, entrega o original com aviso — nunca deforma.
 * Fallback em cascata: qualquer exceção num método pula para o próximo.
 */

import { packGzip } from './container';
import type { FormatInfo } from './formats';
import { asciiStlToBinary } from './validation';
import { normalizeObjText, outputFileName } from './stl-io';
import { validateObjDelivery, validateStlDelivery, type GeometryReport } from './geometry-validator';

export interface BenchmarkEntry {
  id: string;
  label: string;
  bytes: number;
  ratio: number;
  valid: boolean;
  tier: 'A' | 'B';
}

export interface OptimizeResult {
  delivered: Uint8Array;
  deliveredFileName: string;
  method: string;
  methodLabel: string;
  tier: 'A' | 'B';
  originalBytes: number;
  deliveredBytes: number;
  ratio: number;
  faces: number;
  report: GeometryReport | null;
  objFaces: number;
  benchmark: BenchmarkEntry[];
  gzipSecondary: Uint8Array;
  warnings: string[];
  elapsedMs: number;
}

interface Candidate {
  id: string;
  label: string;
  tier: 'A' | 'B';
  build: () => Uint8Array;
}

function stlCandidates(original: Uint8Array, ascii: boolean): Candidate[] {
  if (!ascii) {
    return [{
      id: 'stl-bin-passthrough',
      label: 'Binário já otimizado (passthrough byte-lossless)',
      tier: 'A',
      build: () => original,
    }];
  }
  return [{
    id: 'stl-ascii-to-bin',
    label: 'ASCII → binário (conversão com geometria preservada)',
    tier: 'B',
    build: () => asciiStlToBinary(original),
  }];
}

export async function optimizeDelivery(
  original: Uint8Array,
  fileName: string,
  info: FormatInfo,
  onStage?: (message: string) => void,
): Promise<OptimizeResult> {
  const started = performance.now();
  const warnings: string[] = [];
  const benchmark: BenchmarkEntry[] = [];

  let candidates: Candidate[] = [];
  let kind: 'stl' | 'obj' | 'other' = 'other';
  if (info.format === 'STL_BINARY') {
    kind = 'stl';
    candidates = stlCandidates(original, false);
  } else if (info.format === 'STL_ASCII') {
    kind = 'stl';
    candidates = stlCandidates(original, true);
  } else if (info.format === 'OBJ') {
    kind = 'obj';
    candidates = [{
      id: 'obj-normalize',
      label: 'Normalização de texto OBJ (sem tocar nos números)',
      tier: 'B',
      build: () => normalizeObjText(original).bytes,
    }];
  } else {
    candidates = [{
      id: 'passthrough',
      label: 'Representação original preservada (passthrough byte-lossless)',
      tier: 'A',
      build: () => original,
    }];
  }

  let best: { candidate: Candidate; bytes: Uint8Array; report: GeometryReport | null; objFaces: number } | null = null;

  for (const candidate of candidates) {
    onStage?.(`Testando: ${candidate.label}…`);
    let bytes: Uint8Array;
    try {
      bytes = candidate.build();
    } catch (error) {
      benchmark.push({ id: candidate.id, label: candidate.label, bytes: original.length, ratio: 1, valid: false, tier: candidate.tier });
      warnings.push(`${candidate.label}: falhou (${error instanceof Error ? error.message : 'erro'}). Tentando próximo método.`);
      continue;
    }
    try {
      if (kind === 'stl') {
        const report = validateStlDelivery(original, info.format === 'STL_ASCII', bytes);
        benchmark.push({ id: candidate.id, label: candidate.label, bytes: bytes.length, ratio: bytes.length / Math.max(1, original.length), valid: report.pass, tier: candidate.tier });
        if (!report.pass) {
          warnings.push(`${candidate.label}: reprovado na validação (${report.reasons[0] ?? 'geometria'}).`);
          continue;
        }
        if (!best || bytes.length < best.bytes.length) {
          best = { candidate, bytes, report, objFaces: report.facesFinal };
        }
      } else if (kind === 'obj') {
        const check = validateObjDelivery(original, bytes);
        benchmark.push({ id: candidate.id, label: candidate.label, bytes: bytes.length, ratio: bytes.length / Math.max(1, original.length), valid: check.pass, tier: candidate.tier });
        if (!check.pass) {
          warnings.push(`${candidate.label}: reprovado (${check.reasons[0] ?? 'geometria'}).`);
          continue;
        }
        if (!best || bytes.length < best.bytes.length) {
          best = { candidate, bytes, report: null, objFaces: check.faces };
        }
      } else {
        const identical = bytes.length === original.length && bytes.every((v, i) => v === original[i]);
        benchmark.push({ id: candidate.id, label: candidate.label, bytes: bytes.length, ratio: 1, valid: identical, tier: candidate.tier });
        if (!identical) {
          warnings.push(`${candidate.label}: divergência inesperada.`);
          continue;
        }
        best = { candidate, bytes, report: null, objFaces: info.faces };
      }
    } catch (error) {
      benchmark.push({ id: candidate.id, label: candidate.label, bytes: original.length, ratio: 1, valid: false, tier: candidate.tier });
      warnings.push(`${candidate.label}: erro na validação (${error instanceof Error ? error.message : 'erro'}).`);
    }
  }

  if (!best) {
    throw new Error('Nenhuma compressão segura encontrada — o arquivo original apresenta inconsistências e não foi modificado.');
  }

  const ratio = best.bytes.length / Math.max(1, original.length);
  if (ratio >= 1 && kind !== 'other') {
    warnings.push(
      kind === 'stl' && info.format === 'STL_BINARY'
        ? 'O STL binário já está na representação mais eficiente (84 + 50 bytes/face). Nenhum byte pôde ser removido sem quebrar o formato.'
        : 'Nenhuma compressão segura adicional encontrada. O original foi preservado intacto.',
    );
  }

  onStage?.('Gerando .gz secundário…');
  const gzipSecondary = await packGzip(original);

  const deliveredFileName = outputFileName(fileName);
  return {
    delivered: best.bytes,
    deliveredFileName,
    method: best.candidate.id,
    methodLabel: best.candidate.label,
    tier: best.candidate.tier,
    originalBytes: original.length,
    deliveredBytes: best.bytes.length,
    ratio,
    faces: best.report ? best.report.facesFinal : best.objFaces,
    report: best.report,
    objFaces: best.objFaces,
    benchmark,
    gzipSecondary,
    warnings,
    elapsedMs: performance.now() - started,
  };
}
