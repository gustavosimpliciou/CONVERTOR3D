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
  // CONTROLLED VERTEX WELDING (importação preservada):
  // 1) Passada exata (bit-identical) via hash — O(V), sem risco de fundir
  //    pontos distintos.
  // 2) Passada espacial com tolerância proporcional à escala do modelo
  //    (diagonal * 1e-7, com piso absoluto). Nunca une pontos diferentes
  //    apenas por estarem próximos: só dentro da tolerância dimensional.
  // 3) Union-find com compressão de caminho + reconstrução da conectividade
  //    descartando apenas faces degeneradas em relação à escala.
  const bounds = calculateBounds(new Float32Array(positions));
  const diagonal = Math.hypot(...bounds.size) || 1;
  const tolerance = Math.min(Math.max(diagonal * 1e-7, 1e-12), diagonal * 1e-4);
  const vertexCount = positions.length / 3;
  const parent = new Int32Array(vertexCount);
  for (let i = 0; i < vertexCount; i += 1) parent[i] = i;
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[rb] = ra;
  };
  // Passada 1: duplicatas exatas.
  const exact = new Map<string, number>();
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    const key = `${positions[vertex * 3]}|${positions[vertex * 3 + 1]}|${positions[vertex * 3 + 2]}`;
    const existing = exact.get(key);
    if (existing === undefined) exact.set(key, vertex);
    else union(existing, vertex);
  }
  // Passada 2: vizinhança espacial (somente raízes sobrevivem nos buckets).
  const buckets = new Map<string, number[]>();
  const cell = (value: number) => Math.floor(value / tolerance);
  const distanceSquared = (a: number, b: number) => {
    const dx = positions[a * 3] - positions[b * 3];
    const dy = positions[a * 3 + 1] - positions[b * 3 + 1];
    const dz = positions[a * 3 + 2] - positions[b * 3 + 2];
    return dx * dx + dy * dy + dz * dz;
  };
  const maxDistSq = tolerance * tolerance;
  for (let vertex = 0; vertex < vertexCount; vertex += 1) {
    if (find(vertex) !== vertex) continue; // já fundido na passada exata
    const x = positions[vertex * 3], y = positions[vertex * 3 + 1], z = positions[vertex * 3 + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    const cx = cell(x), cy = cell(y), cz = cell(z);
    let nearest = -1;
    let nearestDist = maxDistSq;
    for (let ox = -1; ox <= 1; ox += 1) for (let oy = -1; oy <= 1; oy += 1) for (let oz = -1; oz <= 1; oz += 1) {
      for (const candidate of buckets.get(`${cx + ox}:${cy + oy}:${cz + oz}`) ?? []) {
        const root = find(candidate);
        if (root === vertex) continue;
        const distance = distanceSquared(vertex, root);
        if (distance <= nearestDist) { nearestDist = distance; nearest = root; }
      }
    }
    if (nearest >= 0) union(vertex, nearest);
    const root = find(vertex);
    const key = `${cx}:${cy}:${cz}`;
    const bucket = buckets.get(key) ?? [];
    if (!bucket.includes(root)) bucket.push(root);
    buckets.set(key, bucket);
  }
  const welded = new Array<number>(vertexCount);
  for (let vertex = 0; vertex < vertexCount; vertex += 1) welded[vertex] = find(vertex);
  // Área degenerada relativa à escala (antes: EPSILON absoluto).
  const minAreaSq = Math.max(diagonal * diagonal * 1e-16, EPSILON);
  const valid: number[] = [];
  for (const triangle of triangles) {
    const normalizedTriangle = triangle.map((index) => welded[index] ?? -1);
    if (normalizedTriangle.some((index) => index < 0)) continue;
    if (normalizedTriangle.length !== 3) continue;
    const [a, b, c] = normalizedTriangle;
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
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    if (nx * nx + ny * ny + nz * nz <= minAreaSq * 4) continue;
    valid.push(a, b, c);
  }
  return compactMesh(positions, valid, format);
}
