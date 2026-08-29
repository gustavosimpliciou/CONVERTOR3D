import type { Bounds, MeshData, MeshStats } from './types';

const EPSILON = 1e-12;

export function calculateBounds(positions: Float32Array): Bounds {
  if (positions.length < 3) {
    return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  }

  const min: [number, number, number] = [
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  ];
  const max: [number, number, number] = [
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  ];

  for (let i = 0; i < positions.length; i += 3) {
    min[0] = Math.min(min[0], positions[i]);
    min[1] = Math.min(min[1], positions[i + 1]);
    min[2] = Math.min(min[2], positions[i + 2]);
    max[0] = Math.max(max[0], positions[i]);
    max[1] = Math.max(max[1], positions[i + 1]);
    max[2] = Math.max(max[2], positions[i + 2]);
  }

  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

export function triangleAreaSquared(
  positions: Float32Array | number[],
  indices: Uint32Array | number[],
  triangle: number,
): number {
  const offset = triangle * 3;
  const ia = indices[offset] * 3;
  const ib = indices[offset + 1] * 3;
  const ic = indices[offset + 2] * 3;
  const abx = positions[ib] - positions[ia];
  const aby = positions[ib + 1] - positions[ia + 1];
  const abz = positions[ib + 2] - positions[ia + 2];
  const acx = positions[ic] - positions[ia];
  const acy = positions[ic + 1] - positions[ia + 1];
  const acz = positions[ic + 2] - positions[ia + 2];
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return nx * nx + ny * ny + nz * nz;
}

export function buildStats(mesh: MeshData): MeshStats {
  let degenerateTriangles = 0;
  let finite = true;
  for (let i = 0; i < mesh.positions.length; i += 1) {
    if (!Number.isFinite(mesh.positions[i])) finite = false;
  }
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i];
    const b = mesh.indices[i + 1];
    const c = mesh.indices[i + 2];
    if (
      a >= mesh.positions.length / 3 ||
      b >= mesh.positions.length / 3 ||
      c >= mesh.positions.length / 3 ||
      a === b ||
      b === c ||
      a === c ||
      triangleAreaSquared(mesh.positions, mesh.indices, i / 3) <= EPSILON
    ) {
      degenerateTriangles += 1;
    }
  }
  return {
    vertices: mesh.positions.length / 3,
    triangles: mesh.indices.length / 3,
    bounds: mesh.bounds,
    finite,
    degenerateTriangles,
  };
}

export function compactMesh(
  positions: number[] | Float32Array,
  indices: number[] | Uint32Array,
  format: MeshData['format'],
): MeshData {
  const used = new Set<number>();
  for (const index of indices) used.add(index);
  const remap = new Map<number, number>();
  const compactPositions: number[] = [];
  let next = 0;
  for (const index of used) {
    remap.set(index, next);
    compactPositions.push(
      positions[index * 3],
      positions[index * 3 + 1],
      positions[index * 3 + 2],
    );
    next += 1;
  }
  const compactIndices = Array.from(indices, (index) => remap.get(index)!);
  const typedPositions = new Float32Array(compactPositions);
  return {
    positions: typedPositions,
    indices: new Uint32Array(compactIndices),
    format,
    bounds: calculateBounds(typedPositions),
  };
}

export function normalizeTriangles(
  positions: number[],
  triangles: number[][],
  format: MeshData['format'],
): MeshData {
  const valid: number[] = [];
  for (const triangle of triangles) {
    if (triangle.length !== 3) continue;
    const [a, b, c] = triangle;
    if (a === b || b === c || a === c) continue;
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    if (
      !Number.isFinite(positions[ia]) ||
      !Number.isFinite(positions[ib]) ||
      !Number.isFinite(positions[ic])
    ) {
      continue;
    }
    valid.push(a, b, c);
  }
  return compactMesh(positions, valid, format);
}