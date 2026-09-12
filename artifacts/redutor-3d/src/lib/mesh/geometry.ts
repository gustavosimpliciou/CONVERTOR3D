import type { Bounds, MeshComparison, MeshData, MeshIntegrity, MeshStats } from './types';

const EPSILON = 1e-12;

export function calculateBounds(positions: Float32Array): Bounds {
  if (positions.length < 3) return { min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0] };
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) for (let axis = 0; axis < 3; axis += 1) { min[axis] = Math.min(min[axis], positions[i + axis]); max[axis] = Math.max(max[axis], positions[i + axis]); }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

export function triangleAreaSquared(positions: Float32Array | number[], indices: Uint32Array | number[], triangle: number): number {
  const o = triangle * 3; const ia = indices[o] * 3; const ib = indices[o + 1] * 3; const ic = indices[o + 2] * 3;
  const abx = positions[ib] - positions[ia], aby = positions[ib + 1] - positions[ia + 1], abz = positions[ib + 2] - positions[ia + 2];
  const acx = positions[ic] - positions[ia], acy = positions[ic + 1] - positions[ia + 1], acz = positions[ic + 2] - positions[ia + 2];
  const nx = aby * acz - abz * acy, ny = abz * acx - abx * acz, nz = abx * acy - aby * acx;
  return nx * nx + ny * ny + nz * nz;
}

const edgeKey = (a: number, b: number) => a < b ? `${a}:${b}` : `${b}:${a}`;

function integrity(mesh: MeshData): MeshIntegrity {
  const edges = new Map<string, number>(); const faces = new Set<string>(); const vertices = new Map<string, number>();
  let degenerateTriangles = 0, invalidNormals = 0, surfaceArea = 0, signedVolume = 0;
  const adjacency = Array.from({ length: mesh.positions.length / 3 }, () => new Set<number>());
  for (let i = 0; i < mesh.positions.length; i += 3) { const key = `${mesh.positions[i].toPrecision(12)}|${mesh.positions[i + 1].toPrecision(12)}|${mesh.positions[i + 2].toPrecision(12)}`; vertices.set(key, (vertices.get(key) ?? 0) + 1); }
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = mesh.indices[t], b = mesh.indices[t + 1], c = mesh.indices[t + 2]; const key = [a, b, c].sort((x, y) => x - y).join(':');
    if (faces.has(key)) continue;
    faces.add(key); for (const [u, v] of [[a, b], [b, c], [c, a]]) edges.set(edgeKey(u, v), (edges.get(edgeKey(u, v)) ?? 0) + 1);
    adjacency[a]?.add(t / 3); adjacency[b]?.add(t / 3); adjacency[c]?.add(t / 3);
    const area2 = triangleAreaSquared(mesh.positions, mesh.indices, t / 3); if (area2 <= EPSILON) { degenerateTriangles += 1; continue; }
    const area = Math.sqrt(area2) / 2; surfaceArea += area;
    const ia = a * 3, ib = b * 3, ic = c * 3; signedVolume += (mesh.positions[ia] * (mesh.positions[ib + 1] * mesh.positions[ic + 2] - mesh.positions[ib + 2] * mesh.positions[ic + 1]) - mesh.positions[ia + 1] * (mesh.positions[ib] * mesh.positions[ic + 2] - mesh.positions[ib + 2] * mesh.positions[ic]) + mesh.positions[ia + 2] * (mesh.positions[ib] * mesh.positions[ic + 1] - mesh.positions[ib + 1] * mesh.positions[ic])) / 6;
    if (![area, signedVolume].every(Number.isFinite)) invalidNormals += 1;
  }
  const seenVertices = new Set<number>(); let components = 0;
  for (let start = 0; start < adjacency.length; start += 1) {
    if (!adjacency[start].size || seenVertices.has(start)) continue;
    components += 1;
    const stack = [start];
    seenVertices.add(start);
    while (stack.length) {
      const vertex = stack.pop()!;
      for (const triangle of adjacency[vertex]) {
        const offset = triangle * 3;
        for (const next of [mesh.indices[offset], mesh.indices[offset + 1], mesh.indices[offset + 2]]) {
          if (!seenVertices.has(next)) { seenVertices.add(next); stack.push(next); }
        }
      }
    }
  }
  return { components, openEdges: [...edges.values()].filter((count) => count === 1).length, nonManifoldEdges: [...edges.values()].filter((count) => count > 2).length, duplicateFaces: Math.max(0, mesh.indices.length / 3 - faces.size), duplicateVertices: [...vertices.values()].filter((count) => count > 1).reduce((sum, count) => sum + count - 1, 0), degenerateTriangles, invalidNormals, surfaceArea, signedVolume };
}

export function buildStats(mesh: MeshData): MeshStats { return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3, bounds: mesh.bounds, finite: Array.from(mesh.positions).every(Number.isFinite), ...integrity(mesh) }; }

export function compareMeshes(original: MeshStats, reduced: MeshStats): MeshComparison {
  const span = Math.max(...original.bounds.size, 1); const boundsDelta = Math.max(...reduced.bounds.min.map((v, i) => Math.abs(v - original.bounds.min[i])), ...reduced.bounds.max.map((v, i) => Math.abs(v - original.bounds.max[i]))) / span;
  const areaRatio = original.surfaceArea ? reduced.surfaceArea / original.surfaceArea : 1; const volumeRatio = Math.abs(original.signedVolume) > EPSILON ? Math.abs(reduced.signedVolume / original.signedVolume) : 1;
  const severity = boundsDelta > 0.02 || reduced.openEdges > original.openEdges || reduced.nonManifoldEdges > original.nonManifoldEdges || reduced.degenerateTriangles > original.degenerateTriangles ? 'error' : boundsDelta > 0.005 || Math.abs(1 - areaRatio) > 0.25 ? 'warning' : 'ok';
  return { boundsDelta, areaRatio, volumeRatio, approximateError: boundsDelta + Math.abs(1 - areaRatio) * 0.25, newOpenEdges: Math.max(0, reduced.openEdges - original.openEdges), newNonManifoldEdges: Math.max(0, reduced.nonManifoldEdges - original.nonManifoldEdges), newDegenerates: Math.max(0, reduced.degenerateTriangles - original.degenerateTriangles), severity };
}

export function compactMesh(positions: number[] | Float32Array, indices: number[] | Uint32Array, format: MeshData['format']): MeshData { const used = new Set(indices); const remap = new Map<number, number>(); const compactPositions: number[] = []; [...used].forEach((index, next) => { remap.set(index, next); compactPositions.push(positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]); }); const typedPositions = new Float32Array(compactPositions); return { positions: typedPositions, indices: new Uint32Array(Array.from(indices, (index) => remap.get(index)!)), format, bounds: calculateBounds(typedPositions) }; }

export function normalizeTriangles(positions: number[], triangles: number[][], format: MeshData['format']): MeshData { const valid: number[] = []; for (const [a, b, c] of triangles) if ([a, b, c].every((v) => Number.isInteger(v) && v >= 0 && v < positions.length / 3) && new Set([a, b, c]).size === 3) { const candidate = [a, b, c]; if (triangleAreaSquared(positions, candidate, 0) > EPSILON) valid.push(a, b, c); } return compactMesh(positions, valid, format); }
