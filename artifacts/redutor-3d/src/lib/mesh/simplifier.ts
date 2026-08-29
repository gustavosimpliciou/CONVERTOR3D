import { calculateBounds, compactMesh, triangleAreaSquared } from './geometry';
import type { MeshData, SimplifyOptions, SimplifyResult } from './types';

type Quadric = [number, number, number, number, number, number, number, number, number, number];
type Candidate = { a: number; b: number; position: [number, number, number]; cost: number; curvature?: number; isSilhouette?: boolean };

const emptyQuadric = (): Quadric => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const addQuadric = (a: Quadric, b: Quadric): Quadric => a.map((value, i) => value + b[i]) as Quadric;
const planeQuadric = (a: number, b: number, c: number, d: number, weight: number): Quadric => [
  a * a * weight, a * b * weight, a * c * weight, a * d * weight,
  b * b * weight, b * c * weight, b * d * weight,
  c * c * weight, c * d * weight, d * d * weight,
];
const evaluate = (q: Quadric, p: [number, number, number]) =>
  q[0] * p[0] * p[0] + 2 * q[1] * p[0] * p[1] + 2 * q[2] * p[0] * p[2] +
  2 * q[3] * p[0] + q[4] * p[1] * p[1] + 2 * q[5] * p[1] * p[2] +
  2 * q[6] * p[1] + q[7] * p[2] * p[2] + 2 * q[8] * p[2] + q[9];

class MinHeap {
  private values: Candidate[] = [];
  push(value: Candidate) {
    this.values.push(value);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent].cost <= value.cost) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = value;
  }
  pop() {
    if (!this.values.length) return undefined;
    const first = this.values[0];
    const last = this.values.pop()!;
    if (this.values.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        if (left >= this.values.length) break;
        const right = left + 1;
        const child = right < this.values.length && this.values[right].cost < this.values[left].cost ? right : left;
        if (this.values[child].cost >= last.cost) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

const keyOf = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function optimalPosition(q: Quadric, a: [number, number, number], b: [number, number, number]): Candidate['position'] {
  const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
  if (Math.abs(det) > 1e-12) {
    const x = -(q[3] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[6] * q[7] - q[5] * q[8]) + q[2] * (q[6] * q[5] - q[4] * q[8])) / det;
    const y = - (q[0] * (q[6] * q[7] - q[5] * q[8]) - q[3] * (q[1] * q[7] - q[5] * q[8]) + q[2] * (q[1] * q[8] - q[6] * q[2])) / det;
    const z = - (q[0] * (q[4] * q[8] - q[6] * q[5]) - q[1] * (q[1] * q[8] - q[6] * q[2]) + q[3] * (q[1] * q[5] - q[4] * q[2])) / det;
    if ([x, y, z].every(Number.isFinite)) return [x, y, z];
  }
  return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
}

function triangleNormal(positions: number[], a: number, b: number, c: number): [number, number, number] {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
}

function calculateCurvature(positions: number[], triangles: number[][], vertexIndex: number): number {
  const vertexTriangles = new Set<number>();
  for (const t of triangles) {
    if (triangles[t][0] === vertexIndex || triangles[t][1] === vertexIndex || triangles[t][2] === vertexIndex) {
      vertexTriangles.add(t);
    }
  }
  if (vertexTriangles.size < 3) return 0;

  let sumAngle = 0;
  let sumArea = 0;
  const indices = triangles[vertexTriangles.values().next().value];
  const a = indices[0], b = indices[1], c = indices[2];
  
  for (const t of vertexTriangles) {
    const [x1, y1, z1] = [positions[t[0]*3], positions[t[0]*3+1], positions[t[0]*3+2]];
    const [x2, y2, z2] = [positions[t[1]*3], positions[t[1]*3+1], positions[t[1]*3+2]];
    const [x3, y3, z3] = [positions[t[2]*3], positions[t[2]*3+1], positions[t[2]*3+2]];
    
    const v1x = x2 - x1, v1y = y2 - y1, v1z = z2 - z1;
    const v2x = x3 - x1, v2y = y3 - y1, v2z = z3 - z1;
    
    const dot = v1x * v2x + v1y * v2y + v1z * v2z;
    const len1 = Math.hypot(v1x, v1y, v1z);
    const len2 = Math.hypot(v2x, v2y, v2z);
    const angle = Math.acos(Math.max(-1, Math.min(1, dot / (len1 * len2 || 1))));
    sumAngle += angle;
    
    const area = Math.abs(x1 * (y2 - y3) + x2 * (y3 - y1) + x3 * (y1 - y2)) / 2;
    sumArea += area;
  }
  
  if (sumArea === 0) return 0;
  return sumAngle / sumArea;
}

function detectSilhouetteEdges(positions: number[], triangles: number[][]): Set<string> {
  const silhouetteEdges = new Set<string>();
  const edgeCounts = new Map<string, number>();
  
  for (const tri of triangles) {
    const [a, b, c] = tri;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = keyOf(u, v);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  
  for (const [key, count] of edgeCounts) {
    if (count === 1) {
      const [u, v] = key.split(':').map(Number);
      silhouetteEdges.add(key);
    }
  }
  
  return silhouetteEdges;
}

function canCollapse(
  positions: number[],
  triangles: number[][],
  affected: Set<number>,
  a: number,
  b: number,
  next: [number, number, number],
  silhouetteEdges: Set<string>,
  borderPenalty: number,
): boolean {
  for (const t of affected) {
    const tri = triangles[t];
    const before = triangleNormal(positions, tri[0], tri[1], tri[2]);
    const afterIndices = tri.map((v) => (v === b ? a : v));
    if (new Set(afterIndices).size < 3) continue;
    const testPositions = positions.slice();
    testPositions[a * 3] = next[0]; testPositions[a * 3 + 1] = next[1]; testPositions[a * 3 + 2] = next[2];
    const after = triangleNormal(testPositions, afterIndices[0], afterIndices[1], afterIndices[2]);
    const beforeLength = Math.hypot(...before);
    const afterLength = Math.hypot(...after);
    if (afterLength < 1e-10 || beforeLength < 1e-10) return false;
    const dot = (before[0] * after[0] + before[1] * after[1] + before[2] * after[2]) / (beforeLength * afterLength);
    if (dot < 0.15) return false;
  }
  
  // Check silhouette preservation
  const keyA = keyOf(a, b);
  if (silhouetteEdges.has(keyA) || silhouetteEdges.has(keyOf(b, a))) {
    // Collapsing a silhouette edge would alter the contour - add extra check
    for (const t of affected) {
      const tri = triangles[t];
      if (tri.includes(a) && tri.includes(b)) {
        const other = tri.find(v => v !== a && v !== b);
        if (other !== undefined) {
          const newNormal = triangleNormal(positions, a === other ? b : a, other, a === other ? b : a);
          // Check if this would flip the silhouette
          const wouldFlip = Math.abs(newNormal[2]) > 0.8; // simplified check
          if (wouldFlip) return false;
        }
      }
    }
  }
  
  return true;
}

export function simplifyMesh(mesh: MeshData, options: SimplifyOptions, onProgress?: (progress: number) => void): SimplifyResult {
  const originalTriangles = mesh.indices.length / 3;
  const target = Math.max(4, Math.floor(options.targetTriangles));
  if (target >= originalTriangles) {
    return { positions: mesh.positions, indices: mesh.indices, triangles: originalTriangles, vertices: mesh.positions.length / 3, reductionPercent: 0, warnings: [] };
  }

  const positions = Array.from(mesh.positions);
  const triangles = Array.from({ length: originalTriangles }, (_, i) => [
    mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2],
  ]);
  const aliveVertices = new Uint8Array(positions.length / 3).fill(1);
  const quadrics = Array.from({ length: aliveVertices.length }, emptyQuadric);
  const vertexTriangles = Array.from({ length: aliveVertices.length }, () => new Set<number>());
  const edges = new Set<string>();
  const edgeCounts = new Map<string, number>();
  const faceNormals: [number, number, number][] = [];
  const vertexCurvatures: number[] = new Float32Array(positions.length / 3).fill(0);

  // Step 1: Build triangle data and quadrics
  for (let t = 0; t < triangles.length; t += 1) {
    const [a, b, c] = triangles[t];
    vertexTriangles[a].add(t); vertexTriangles[b].add(t); vertexTriangles[c].add(t);
    const normal = triangleNormal(positions, a, b, c);
    faceNormals.push(normal);
    const length = Math.hypot(...normal);
    if (length > 1e-12) {
      const nx = normal[0] / length, ny = normal[1] / length, nz = normal[2] / length;
      const d = -(nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2]);
      const q = planeQuadric(nx, ny, nz, d, 1);
      quadrics[a] = addQuadric(quadrics[a], q); quadrics[b] = addQuadric(quadrics[b], q); quadrics[c] = addQuadric(quadrics[c], q);
    }
    // Calculate curvature at each vertex
    for (const v of [a, b, c]) {
      vertexCurvatures[v] = Math.max(vertexCurvatures[v], calculateCurvature(positions, triangles, v));
    }
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = keyOf(u, v);
      edges.add(key);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Step 2: Detect silhouette edges and border edges
  const silhouetteEdges = options.preserveSilhouette ? detectSilhouetteEdges(positions, triangles) : new Set();
  
  // Step 3: Setup quality-based weights
  const borderWeight = options.quality === 'ultra' ? 100 : options.quality === 'high' ? 35 : options.quality === 'medium' ? 12 : 4;
  const detailPenalty = options.protectDetails ? (options.quality === 'ultra' ? 1.8 : options.quality === 'high' ? 1.35 : 1.1) : 1;
  const curvatureThreshold = options.quality === 'ultra' ? 0.5 : options.quality === 'high' ? 0.3 : options.quality === 'medium' ? 0.15 : 0.05;

  // Step 4: Add border quadrics with enhanced penalty
  if (options.preserveBorders) {
    for (const key of edges) {
      if (edgeCounts.get(key) !== 1) continue;
      const [a, b] = key.split(':').map(Number);
      const neighbors = Array.from(vertexTriangles[a]).filter((t) => triangles[t].includes(b));
      if (neighbors.length === 0) continue;
      const normal = faceNormals[neighbors[0]];
      const length = Math.hypot(...normal);
      if (!length) continue;
      const nx = normal[0] / length, ny = normal[1] / length, nz = normal[2] / length;
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const edgeNormal = [ey * nz - ez * ny, ez * nx - ex * nz, ex * ny - ey * nx] as [number, number, number];
      const el = Math.hypot(...edgeNormal);
      if (el) {
        edgeNormal[0] /= el; edgeNormal[1] /= el; edgeNormal[2] /= el;
        const d = -(edgeNormal[0] * ax + edgeNormal[1] * ay + edgeNormal[2] * az);
        const q = planeQuadric(edgeNormal[0], edgeNormal[1], edgeNormal[2], d, borderWeight);
        quadrics[a] = addQuadric(quadrics[a], q); quadrics[b] = addQuadric(quadrics[b], q);
      }
    }
  }

  // Step 5: Add curvature-based penalties - high curvature vertices get higher cost
  const curvaturePenaltyFactor = (curv: number) => {
    if (curv > curvatureThreshold) {
      return options.quality === 'ultra' ? 3 : options.quality === 'high' ? 2 : 1.5;
    }
    return 1;
  };

  // Step 6: Initialize priority queue with edge costs
  const heap = new MinHeap();
  const pushEdge = (a: number, b: number) => {
    if (a === b || !aliveVertices[a] || !aliveVertices[b]) return;
    const q = addQuadric(quadrics[a], quadrics[b]);
    const pa: [number, number, number] = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
    const pb: [number, number, number] = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
    const position = optimalPosition(q, pa, pb);
    const baseCost = evaluate(q, position) * detailPenalty;
    
    // Apply curvature penalty - high curvature edges cost more to collapse
    const ca = vertexCurvatures[a] || 0;
    const cb = vertexCurvatures[b] || 0;
    const avgCurvature = (ca + cb) / 2;
    const curvatureMult = curvaturePenaltyFactor(avgCurvature);
    
    // Apply silhouette penalty
    const isSilhouette = silhouetteEdges.has(keyOf(a, b)) || silhouetteEdges.has(keyOf(b, a));
    const silhouetteMult = isSilhouette ? (options.quality === 'ultra' ? 5 : options.quality === 'high' ? 3 : 2) : 1;
    
    heap.push({ a, b, position, cost: baseCost * curvatureMult * silhouetteMult, curvature: avgCurvature, isSilhouette });
  };
  for (const key of edges) {
    const [a, b] = key.split(':').map(Number);
    pushEdge(a, b);
  }

  // Step 7: Progressive edge collapse
  let activeTriangles = triangles.length;
  let iterations = 0;
  const maxIterations = Math.max(1000, originalTriangles * 3);
  const progressStep = Math.max(1, Math.floor((originalTriangles - target) / 25));
  
  let collapseCount = 0;
  
  while (activeTriangles > target && iterations < maxIterations) {
    iterations += 1;
    const candidate = heap.pop();
    if (!candidate) break;
    
    const { a, b, position, cost, curvature, isSilhouette } = candidate;
    if (!aliveVertices[a] || !aliveVertices[b] || !edges.has(keyOf(a, b))) continue;
    
    const affected = new Set<number>([...vertexTriangles[a], ...vertexTriangles[b]]);
    if (!canCollapse(positions, triangles, affected, a, b, position, silhouetteEdges, borderWeight)) continue;

    // Execute collapse
    const touchedEdges = new Set<string>();
    for (const t of affected) {
      const tri = triangles[t];
      for (const [u, v] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) touchedEdges.add(keyOf(u, v));
    }
    for (const key of touchedEdges) edges.delete(key);
    
    positions[a * 3] = position[0]; positions[a * 3 + 1] = position[1]; positions[a * 3 + 2] = position[2];
    quadrics[a] = addQuadric(quadrics[a], quadrics[b]);
    aliveVertices[b] = 0;
    
    for (const t of affected) {
      const tri = triangles[t];
      for (const v of tri) vertexTriangles[v].delete(t);
      triangles[t] = tri.map((v) => (v === b ? a : v));
      const updated = triangles[t];
      if (new Set(updated).size < 3) {
        if (triangles[t][0] !== -1) activeTriangles -= 1;
        triangles[t] = [-1, -1, -1];
        continue;
      }
      for (const v of updated) vertexTriangles[v].add(t);
      for (const [u, v] of [[updated[0], updated[1]], [updated[1], updated[2]], [updated[2], updated[0]]]) {
        const key = keyOf(u, v);
        edges.add(key);
        pushEdge(u, v);
      }
    }
    
    collapseCount += 1;
    const progress = 1 - (activeTriangles - target) / Math.max(1, originalTriangles - target);
    if (iterations % Math.max(1, Math.floor(originalTriangles / 25)) === 0) onProgress?.(Math.min(0.99, Math.max(0, progress)));
  }

  // Step 8: Generate output
  let outputTriangles: number[] = [];
  for (const tri of triangles) {
    if (tri[0] >= 0 && tri[1] >= 0 && tri[2] >= 0 && new Set(tri).size === 3) outputTriangles.push(...tri);
  }
  if (outputTriangles.length / 3 > target) {
    const sourceCount = outputTriangles.length / 3;
    const fallback: number[] = [];
    for (let i = 0; i < target; i += 1) {
      const at = Math.min(sourceCount - 1, Math.floor((i * sourceCount) / target));
      fallback.push(outputTriangles[at * 3], outputTriangles[at * 3 + 1], outputTriangles[at * 3 + 2]);
    }
    outputTriangles = fallback;
  }
  const compact = compactMesh(positions, outputTriangles, mesh.format);
  return {
    positions: compact.positions,
    indices: compact.indices,
    triangles: compact.indices.length / 3,
    vertices: compact.positions.length / 3,
    reductionPercent: ((originalTriangles - compact.indices.length / 3) / originalTriangles) * 100,
    warnings: activeTriangles > target ? ['A malha exigiu uma amostragem de segurança para respeitar o limite máximo de triângulos.'] : [],
  };
}