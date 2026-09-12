/**
 * STL / OBJ IO para o otimizador de representação.
 * -------------------------------------------------
 * INVESTIGAÇÃO DA ESTRUTURA (documentada como decisão):
 *
 * - STL BINÁRIO tem tamanho FIXO: 84 + 50×N bytes. Com o mesmo N e um
 *   arquivo válido, o tamanho NÃO pode diminuir — qualquer byte a menos
 *   quebra a estrutura. Conclusão honesta: binário→binário com mesma
 *   geometria = mesmos bytes (passthrough byte-lossless). A ordem dos
 *   triângulos foi investigada e NÃO altera o tamanho (registros fixos),
 *   então é mantida estável.
 * - STL ASCII → BINÁRIO é a grande vitória: texto verboso vira 50
 *   bytes/triângulo (tipicamente 60–85% menor), geometria preservada em
 *   float32 (GEOMETRY LOSSLESS, nível B — nunca chamado de byte-lossless).
 * - OBJ texto: apenas normalização de espaços/comentários, sem tocar em
 *   nenhum dígito numérico (nível B, geometria idêntica ao parsear).
 *
 * PROIBIDO aqui (e inexistente neste módulo): decimation, remeshing,
 * smoothing, quantização, float32→float16, arredondamento, snap, merge.
 */

import { calculateBounds, normalizeTriangles } from '../mesh/geometry';
import type { MeshData } from '../mesh/types';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface ParsedStl {
  mesh: MeshData;
  faces: number;
  /** Coordenadas float32 exatas na ordem das faces (para comparação rigorosa). */
  coords: Float32Array;
  normals: Float32Array;
}

/** Lê STL binário e reconstrói a malha (parser independente do resto). */
export function readBinaryStlMesh(bytes: Uint8Array): ParsedStl {
  if (bytes.length < 84) throw new Error('STL binário curto demais.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const faces = view.getUint32(80, true);
  if (faces === 0 || 84 + faces * 50 !== bytes.length) {
    throw new Error('STL binário com contagem inconsistente.');
  }
  const positions: number[] = [];
  const triangles: number[][] = [];
  const coords = new Float32Array(faces * 9);
  const normals = new Float32Array(faces * 3);
  for (let t = 0; t < faces; t += 1) {
    const base = 84 + t * 50;
    for (let c = 0; c < 3; c += 1) {
      const n = view.getFloat32(base + c * 4, true);
      if (!Number.isFinite(n)) throw new Error('Normal inválida no STL.');
      normals[t * 3 + c] = n;
    }
    const tri: number[] = [];
    for (let v = 0; v < 3; v += 1) {
      for (let c = 0; c < 3; c += 1) {
        const value = view.getFloat32(base + 12 + v * 12 + c * 4, true);
        if (!Number.isFinite(value)) throw new Error('Coordenada inválida no STL.');
        coords[t * 9 + v * 3 + c] = value;
      }
      positions.push(
        coords[t * 9 + v * 3], coords[t * 9 + v * 3 + 1], coords[t * 9 + v * 3 + 2],
      );
      tri.push(positions.length / 3 - 1);
    }
    triangles.push(tri);
  }
  const mesh = normalizeTriangles(positions, triangles, 'STL');
  return { mesh, faces, coords, normals };
}

/** Lê STL ASCII para comparação geométrica (decimais → float32). */
export function parseAsciiStlMesh(text: string): ParsedStl {
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
    throw new Error('STL ASCII sem triângulos válidos.');
  }
  const coords = new Float32Array(verts);
  const normals32 = new Float32Array(normals.slice(0, faces * 3));
  const triangles: number[][] = [];
  for (let t = 0; t < faces; t += 1) triangles.push([t * 3, t * 3 + 1, t * 3 + 2]);
  const mesh = normalizeTriangles(Array.from(coords), triangles, 'STL');
  return { mesh, faces, coords, normals: normals32 };
}

/**
 * Normalização OBJ sem tocar na geometria: remove comentários e colapsa
 * espaços. Nenhum dígito numérico é alterado, adicionado ou removido —
 * o parse resultante é idêntico.
 */
export function normalizeObjText(bytes: Uint8Array): { bytes: Uint8Array; changed: boolean } {
  const text = decoder.decode(bytes);
  const out: string[] = [];
  let changed = false;
  for (const rawLine of text.split('\n')) {
    // Remove comentário: '#' até o fim da linha (fora de tokens).
    const hash = rawLine.indexOf('#');
    const stripped = (hash >= 0 ? rawLine.slice(0, hash) : rawLine).replace(/[ \t\r]+/g, ' ').trim();
    if (hash >= 0) changed = true;
    if (stripped === '') {
      if (rawLine.length > 0) changed = true;
      continue;
    }
    if (stripped !== rawLine.replace(/\r$/, '')) changed = true;
    out.push(stripped);
  }
  if (!changed) return { bytes, changed: false };
  return { bytes: encoder.encode(out.join('\n') + '\n'), changed: true };
}

/** Extrai coordenadas 'v' do OBJ para comparação exata. */
export function extractObjCoords(bytes: Uint8Array): number[] {
  const text = decoder.decode(bytes);
  const coords: number[] = [];
  for (const line of text.split('\n')) {
    const m = line.trim().match(/^v\s+(\S+)\s+(\S+)\s+(\S+)/);
    if (m) coords.push(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return coords;
}

/** Conta faces 'f' do OBJ de forma leve. */
export function countObjFaces(bytes: Uint8Array): number {
  const text = decoder.decode(bytes);
  let count = 0;
  for (const line of text.split('\n')) {
    if (/^f\s+\S/.test(line.trim())) count += 1;
  }
  return count;
}

export function outputFileName(inputName: string, suffix = '_comprimido'): string {
  const dot = inputName.lastIndexOf('.');
  if (dot < 0) return `${inputName}${suffix}`;
  return `${inputName.slice(0, dot)}${suffix}${inputName.slice(dot)}`;
}

export function meshBoundsOf(mesh: MeshData): { min: number[]; max: number[]; size: number[] } {
  const bounds = mesh.bounds ?? calculateBounds(mesh.positions);
  return { min: [...bounds.min], max: [...bounds.max], size: [...bounds.size] };
}
