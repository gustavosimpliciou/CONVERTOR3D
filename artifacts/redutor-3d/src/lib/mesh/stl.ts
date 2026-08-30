import { buildStats, calculateBounds } from './geometry';
import type { BinaryStlResult, MeshData } from './types';

function normal(positions: Float32Array, indices: Uint32Array, triangle: number): [number, number, number] {
  const a = indices[triangle * 3] * 3;
  const b = indices[triangle * 3 + 1] * 3;
  const c = indices[triangle * 3 + 2] * 3;
  const abx = positions[b] - positions[a], aby = positions[b + 1] - positions[a + 1], abz = positions[b + 2] - positions[a + 2];
  const acx = positions[c] - positions[a], acy = positions[c + 1] - positions[a + 1], acz = positions[c + 2] - positions[a + 2];
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}

export function exportBinaryStl(mesh: MeshData): BinaryStlResult {
  const stats = buildStats(mesh);
  if (!stats.finite || stats.degenerateTriangles > 0 || !mesh.indices.length) {
    return { buffer: new ArrayBuffer(0), triangles: 0, bounds: stats.bounds, valid: false, error: 'A malha contém faces inválidas.' };
  }
  const triangles = mesh.indices.length / 3;
  const buffer = new ArrayBuffer(84 + triangles * 50);
  const view = new DataView(buffer);
  const header = 'REDUTOR 3D — binary STL / validated';
  new TextEncoder().encode(header).forEach((byte, i) => view.setUint8(i, byte));
  view.setUint32(80, triangles, true);
  for (let i = 0; i < triangles; i += 1) {
    const offset = 84 + i * 50;
    const [nx, ny, nz] = normal(mesh.positions, mesh.indices, i);
    view.setFloat32(offset, nx, true); view.setFloat32(offset + 4, ny, true); view.setFloat32(offset + 8, nz, true);
    for (let j = 0; j < 3; j += 1) {
      const vertex = mesh.indices[i * 3 + j] * 3;
      view.setFloat32(offset + 12 + j * 12, mesh.positions[vertex], true);
      view.setFloat32(offset + 16 + j * 12, mesh.positions[vertex + 1], true);
      view.setFloat32(offset + 20 + j * 12, mesh.positions[vertex + 2], true);
    }
    view.setUint16(offset + 48, 0, true);
  }
  const valid = validateBinaryStl(buffer);
  return { buffer, triangles, bounds: calculateBounds(mesh.positions), valid, error: valid ? undefined : 'O STL gerado falhou na validação.' };
}

export function validateBinaryStl(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  if (buffer.byteLength !== 84 + triangles * 50) return false;
  for (let triangle = 0; triangle < triangles; triangle += 1) {
    const offset = 84 + triangle * 50;
    for (let floatOffset = 0; floatOffset < 48; floatOffset += 4) {
      if (!Number.isFinite(view.getFloat32(offset + floatOffset, true))) return false;
    }
  }
  return true;
}