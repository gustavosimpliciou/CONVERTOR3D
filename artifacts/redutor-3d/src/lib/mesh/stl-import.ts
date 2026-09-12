/**
 * PARSER DE IMPORTAÇÃO (upload) — separado do otimizador.
 * ---------------------------------------------------------
 * REGRA SUPREMA DESTE MÓDULO: upload não é otimização.
 *
 * - Decide APENAS se o arquivo pode ser lido (estrutura válida).
 * - NUNCA chama o motor de redução, nunca avalia target, nunca rejeita
 *   por incapacidade de reduzir.
 * - Erros são específicos (truncado, inválido, vazio, formato) — nunca
 *   "não pôde ser lido" genérico por causa de otimização.
 * - Geometria problemática porém legível (aberturas, non-manifold,
 *   degenerados) é ACEITA com `quirks` — vira "estratégia especial",
 *   não recusa.
 * - Detecção por CONTEÚDO (magic/estrutura), nunca só pela extensão.
 * - Sem dependência de three.js: testável em Node puro.
 */

import { detectFormat } from '../compress/formats';
import { parseAsciiStlMesh, readBinaryStlMesh } from '../compress/stl-io';
import { auditMesh, type TopologyAudit } from './validation';
import { buildStats } from './geometry';
import type { MeshData, MeshStats } from './types';

export interface ImportedModel {
  mesh: MeshData;
  stats: MeshStats;
  /** Rótulo para a UI: 'STL binário' | 'STL ASCII' | ... */
  formatLabel: string;
  audit: TopologyAudit;
  /** Características que pedem estratégia especial (não são recusa). */
  quirks: string[];
}

/** Sinaliza "não é STL — use o parser geral" (fallback, não é erro fatal). */
export class NotStlError extends Error {
  constructor() {
    super('NOT_STL');
    this.name = 'NotStlError';
  }
}

function toMeshData(parsed: { mesh: MeshData }): MeshData {
  return parsed.mesh;
}

export function parseStlForImport(bytes: Uint8Array, fileName: string): ImportedModel {
  if (bytes.length === 0) throw new Error('Arquivo vazio.');
  const lowerName = fileName.toLowerCase();
  const isStlName = lowerName.endsWith('.stl');
  const info = detectFormat(fileName, bytes);

  // Rota principal: STL por conteúdo (confiança magic/structure). Dica só
  // pela extensão ('hint') NÃO decide sozinha — cai no tenta-ambos abaixo,
  // que produz "inválido ou corrompido" em vez de "truncado" enganoso.
  const binarySure = info.format === 'STL_BINARY' && info.confidence !== 'hint';
  const asciiSure = info.format === 'STL_ASCII' && info.confidence !== 'hint';
  if (binarySure || (isStlName && info.format !== 'STL_ASCII' && looksBinaryStl(bytes))) {
    return finishBinaryStrict(bytes);
  }
  if (asciiSure || (isStlName && looksAsciiStl(bytes))) {
    return finishAscii(bytes);
  }
  // Nome .stl mas conteúdo ambíguo: tenta os dois formatos e devolve o
  // erro MAIS específico (nunca engole "truncado" num "inválido" genérico).
  if (isStlName) {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 128)));
    const wantsAscii = /^\s*solid/i.test(head);
    let firstErr: unknown = null;
    let secondErr: unknown = null;
    try {
      return wantsAscii ? finishAscii(bytes) : finishBinaryStrict(bytes);
    } catch (error) {
      firstErr = error;
    }
    try {
      return wantsAscii ? finishBinaryStrict(bytes) : finishAscii(bytes);
    } catch (error) {
      secondErr = error;
    }
    const specific = (error: unknown): string | null => {
      if (!(error instanceof Error)) return null;
      return /truncado|sem triângulos|corrompido|inválido|vazio/i.test(error.message) ? error.message : null;
    };
    throw new Error(specific(firstErr) ?? specific(secondErr) ?? 'Arquivo STL inválido ou corrompido.');
  }
  // Outros formatos ficam para o parser geral (fallback dinâmico no worker).
  throw new NotStlError();
}

function looksBinaryStl(bytes: Uint8Array): boolean {
  if (bytes.length < 84) return false;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  return count > 0 && 84 + count * 50 === bytes.length;
}

function looksAsciiStl(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  const head = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)).slice(0, 2048));
  return /^\s*solid/i.test(head) && /facet/i.test(head) && /vertex/i.test(head);
}

function finishBinaryStrict(bytes: Uint8Array): ImportedModel {
  if (bytes.length < 84) throw new Error('STL binário truncado (cabeçalho incompleto).');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(80, true);
  const expected = 84 + count * 50;
  if (count === 0) throw new Error('STL binário sem triângulos.');
  if (expected > bytes.length) {
    throw new Error(
      `STL binário truncado ou inconsistente (esperado ${expected} bytes, encontrado ${bytes.length}).`,
    );
  }
  const geometry = expected < bytes.length ? bytes.subarray(0, expected) : bytes;
  let parsed;
  try {
    parsed = readBinaryStlMesh(geometry);
  } catch {
    throw new Error('STL binário corrompido (coordenadas inválidas).');
  }
  const model = finishCommon(toMeshData(parsed), parsed.faces, 'STL binário');
  if (expected < bytes.length) {
    model.quirks.push('Bytes extras após as faces foram ignorados na leitura.');
  }
  return model;
}

function finishAscii(bytes: Uint8Array): ImportedModel {
  const text = new TextDecoder().decode(bytes);
  let parsed;
  try {
    parsed = parseAsciiStlMesh(text);
  } catch {
    throw new Error('STL ASCII inválido (estrutura facet/vertex não reconhecida).');
  }
  return finishCommon(toMeshData(parsed), parsed.faces, 'STL ASCII');
}

function finishCommon(mesh: MeshData, faces: number, formatLabel: string): ImportedModel {
  void faces;
  const stats = buildStats(mesh);
  if (stats.triangles === 0) throw new Error('O arquivo não contém geometria válida (0 faces).');
  if (!stats.finite) throw new Error('Arquivo corrompido: valores inválidos na geometria.');
  const audit = auditMesh(mesh);
  const quirks: string[] = [];
  if (audit.boundaryLoops > 0) {
    quirks.push(
      `Modelo com ${audit.boundaryLoops.toLocaleString('pt-BR')} abertura(s) original(is) — serão preservadas e exigem estratégia especial.`,
    );
  }
  if (audit.nonManifoldEdges > 0) {
    quirks.push('Geometria com arestas non-manifold — a redução será conservadora nessas regiões.');
  }
  if (audit.degenerateTriangles > 0) {
    quirks.push('Faces degeneradas descartadas na leitura — o restante foi preservado.');
  }
  if (audit.orientationConflicts > 0) {
    quirks.push('Orientação de faces inconsistente no original — preservada como está.');
  }
  return { mesh, stats, formatLabel, audit, quirks };
}
