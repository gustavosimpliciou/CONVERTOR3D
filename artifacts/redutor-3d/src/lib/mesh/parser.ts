import { buildStats, calculateBounds, normalizeTriangles } from './geometry';
import type { MeshData, MeshFormat } from './types';

const decoder = new TextDecoder();

function extensionFormat(name: string): MeshFormat | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'stl') return 'STL';
  if (extension === 'obj') return 'OBJ';
  if (extension === 'ply') return 'PLY';
  if (extension === 'off') return 'OFF';
  if (extension === 'glb') return 'GLB';
  if (extension === 'gltf') return 'GLTF';
  return undefined;
}

function parseBinaryStl(buffer: ArrayBuffer): MeshData | null {
  if (buffer.byteLength < 84) return null;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  if (triangles === 0 || 84 + triangles * 50 > buffer.byteLength) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();
  const readVertex = (offset: number) => {
    const x = view.getFloat32(offset, true);
    const y = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    if (![x, y, z].every(Number.isFinite)) throw new Error('Valores inválidos no STL.');
    const key = `${x}|${y}|${z}`;
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, y, z);
    vertexMap.set(key, index);
    return index;
  };
  for (let i = 0; i < triangles; i += 1) {
    const base = 84 + i * 50;
    indices.push(readVertex(base + 12), readVertex(base + 24), readVertex(base + 36));
  }
  const mesh = normalizeTriangles(positions, Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3)), 'STL');
  return buildStats(mesh).triangles > 0 ? mesh : null;
}

function parseAsciiStl(text: string): MeshData | null {
  if (!/facet\s+normal/i.test(text) || !/vertex/i.test(text)) return null;
  const positions: number[] = [];
  const triangles: number[][] = [];
  const vertices: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/i);
    if (!match) continue;
    vertices.push(Number(match[1]), Number(match[2]), Number(match[3]));
    if (vertices.length === 9) {
      const start = positions.length / 3;
      positions.push(...vertices);
      triangles.push([start, start + 1, start + 2]);
      vertices.length = 0;
    }
  }
  return triangles.length ? normalizeTriangles(positions, triangles, 'STL') : null;
}

function parseObj(text: string): MeshData {
  const positions: number[] = [];
  const triangles: number[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0] === 'v' && parts.length >= 4) {
      positions.push(Number(parts[1]), Number(parts[2]), Number(parts[3]));
    } else if (parts[0] === 'f' && parts.length >= 4) {
      const face = parts.slice(1).map((part) => {
        const raw = Number(part.split('/')[0]);
        return raw < 0 ? positions.length / 3 + raw : raw - 1;
      });
      for (let i = 1; i < face.length - 1; i += 1) triangles.push([face[0], face[i], face[i + 1]]);
    }
  }
  return normalizeTriangles(positions, triangles, 'OBJ');
}

function parsePly(text: string): MeshData {
  const end = text.indexOf('end_header');
  if (end < 0) throw new Error('Cabeçalho PLY inválido.');
  const header = text.slice(0, end);
  if (/format\s+binary/i.test(header)) throw new Error('PLY binário ainda não é suportado neste navegador.');
  const lines = text.slice(end).split(/\r?\n/).slice(1);
  const vertexCount = Number(header.match(/element\s+vertex\s+(\d+)/i)?.[1] ?? 0);
  const faceCount = Number(header.match(/element\s+face\s+(\d+)/i)?.[1] ?? 0);
  const positions: number[] = [];
  for (let i = 0; i < vertexCount; i += 1) {
    const parts = lines[i]?.trim().split(/\s+/).map(Number) ?? [];
    positions.push(parts[0], parts[1], parts[2]);
  }
  const triangles: number[][] = [];
  for (let i = 0; i < faceCount; i += 1) {
    const parts = lines[vertexCount + i]?.trim().split(/\s+/).map(Number) ?? [];
    const count = parts[0];
    const face = parts.slice(1, count + 1);
    for (let j = 1; j < face.length - 1; j += 1) triangles.push([face[0], face[j], face[j + 1]]);
  }
  return normalizeTriangles(positions, triangles, 'PLY');
}

function parseOff(text: string): MeshData {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines[0]?.toUpperCase() !== 'OFF') throw new Error('Arquivo OFF inválido.');
  const counts = lines[1].split(/\s+/).map(Number);
  const positions: number[] = [];
  for (let i = 0; i < counts[0]; i += 1) positions.push(...lines[2 + i].split(/\s+/).slice(0, 3).map(Number));
  const triangles: number[][] = [];
  for (let i = 0; i < counts[1]; i += 1) {
    const parts = lines[2 + counts[0] + i].split(/\s+/).map(Number);
    const face = parts.slice(1, parts[0] + 1);
    for (let j = 1; j < face.length - 1; j += 1) triangles.push([face[0], face[j], face[j + 1]]);
  }
  return normalizeTriangles(positions, triangles, 'OFF');
}

function parseGlb(buffer: ArrayBuffer, format: 'GLB' | 'GLTF'): MeshData {
  let json: any;
  let binary: Uint8Array | undefined;
  if (format === 'GLB') {
    const view = new DataView(buffer);
    if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Cabeçalho GLB inválido.');
    let offset = 12;
    while (offset + 8 <= buffer.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const chunk = new Uint8Array(buffer, offset + 8, length);
      if (type === 0x4e4f534a) json = JSON.parse(decoder.decode(chunk));
      if (type === 0x004e4942) binary = chunk;
      offset += 8 + length;
    }
  } else {
    json = JSON.parse(decoder.decode(buffer));
    const uri = json.buffers?.[0]?.uri;
    if (uri?.startsWith('data:')) binary = Uint8Array.from(atob(uri.split(',')[1]), (char) => char.charCodeAt(0));
  }
  if (!json || !binary) throw new Error('GLTF/GLB precisa conter dados binários incorporados.');
  const positions: number[] = [];
  const triangles: number[][] = [];
  const readAccessor = (accessorIndex: number): number[] => {
    const accessor = json.accessors[accessorIndex];
    const viewDef = json.bufferViews[accessor.bufferView];
    const componentSize = accessor.componentType === 5125 ? 4 : accessor.componentType === 5123 ? 2 : 1;
    const count = accessor.count;
    const offset = (viewDef.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const result: number[] = [];
    for (let i = 0; i < count; i += 1) {
      const at = offset + i * (viewDef.byteStride ?? componentSize);
      if (accessor.componentType === 5125) result.push(new DataView(binary!.buffer, binary!.byteOffset + at, 4).getUint32(0, true));
      else if (accessor.componentType === 5123) result.push(new DataView(binary!.buffer, binary!.byteOffset + at, 2).getUint16(0, true));
      else result.push(binary![at]);
    }
    return result;
  };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const pos = readAccessor(primitive.attributes.POSITION);
      for (let i = 0; i < pos.length; i += 1) positions.push(pos[i]);
      const base = positions.length / 3 - pos.length / 3;
      const indices = primitive.indices === undefined ? Array.from({ length: pos.length / 3 }, (_, i) => i) : readAccessor(primitive.indices);
      for (let i = 0; i < indices.length; i += 3) triangles.push([base + indices[i], base + indices[i + 1], base + indices[i + 2]]);
    }
  }
  return normalizeTriangles(positions, triangles, format);
}

export function parseMesh(buffer: ArrayBuffer, fileName: string): MeshData {
  const bytes = new Uint8Array(buffer);
  const text = decoder.decode(bytes);
  const hinted = extensionFormat(fileName);
  let mesh: MeshData | null = null;
  try {
    mesh = parseBinaryStl(buffer) ?? parseAsciiStl(text);
    if (mesh) return mesh;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Não foi possível ler o STL.');
  }
  const firstLine = text.split(/\r?\n/)[0]?.trim().toUpperCase();
  if (hinted === 'OBJ' || /^V\s+[-\d]/i.test(text) || /\nf\s+/.test(text)) mesh = parseObj(text);
  else if (hinted === 'PLY' || firstLine === 'PLY') mesh = parsePly(text);
  else if (hinted === 'OFF' || firstLine === 'OFF') mesh = parseOff(text);
  else if (hinted === 'GLB') mesh = parseGlb(buffer, 'GLB');
  else if (hinted === 'GLTF' || firstLine.startsWith('{')) mesh = parseGlb(buffer, 'GLTF');
  else throw new Error('Formato não suportado. Use STL, OBJ, PLY, OFF, GLB ou GLTF.');

  if (!mesh || !mesh.indices.length) throw new Error('Malha vazia ou impossível de processar.');
  const stats = buildStats(mesh);
  if (!stats.finite) throw new Error('A malha contém valores inválidos.');
  return { ...mesh, bounds: calculateBounds(mesh.positions) };
}