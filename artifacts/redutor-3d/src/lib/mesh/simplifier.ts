import { calculateBounds, compactMesh, triangleAreaSquared } from './geometry';
import type { MeshData, SimplifyOptions, SimplifyResult } from './types';

type Quadric = [number, number, number, number, number, number, number, number, number, number];
type Candidate = { a: number; b: number; position: [number, number, number]; cost: number };

const emptyQuadric = (): Quadric => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const addQuadric = (a: Quadric, b: Quadric): Quadric => {
  a[0] += b[0]; a[1] += b[1]; a[2] += b[2]; a[3] += b[3];
  a[4] += b[4]; a[5] += b[5]; a[6] += b[6]; a[7] += b[7];
  a[8] += b[8]; a[9] += b[9];
  return a;
};

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

const keyOf = (a: number, b: number) => (a < b ? (a << 16) | b : (b << 16) | a);

function optimalPosition(q: Quadric, a: [number, number, number], b: [number, number, number]): Candidate['position'] {
  const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
  if (Math.abs(det) > 1e-12) {
    const x = -(q[3] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[6] * q[7] - q[5] * q[8]) + q[2] * (q[6] * q[5] - q[4] * q[8])) / det;
    const y = - (q[0] * (q[6] * q[7] - q[5] * q[8]) - q[3] * (q[1] * q[7] - q[5] * q[8]) + q[2] * (q[1] * q[8] - q[6] * q[2])) / det;
    const z = - (q[0] * (q[4] * q[8] - q[6] * q[5]) - q[1] * (q[1] * q[8] - q[6] * q[2]) + q[3] * (q[1] * q[5] - q[4] * q[2])) / det;
    if ([x, y, z].every(Number.isFinite)) return [x, y, z];
  }
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

function triangleNormal(positions: number[], a: number, b: number, c: number): [number, number, number] {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
}

function canCollapseFast(
  positions: number[],
  triangles: number[][],
  affected: number[],
  a: number,
  b: number,
  next: [number, number, number],
  dotThreshold: number
): boolean {
  const nx = next[0], ny = next[1], nz = next[2];
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  
  for (let i = 0, len = affected.length; i < len; i++) {
    const t = affected[i];
    const tri = triangles[t];
    const a0 = tri[0], b0 = tri[1], c0 = tri[2];
    
    const ax0 = positions[a0 * 3], ay0 = positions[a0 * 3 + 1], az0 = positions[a0 * 3 + 2];
    const bx0 = positions[b0 * 3], by0 = positions[b0 * 3 + 1], bz0 = positions[b0 * 3 + 2];
    const cx0 = positions[c0 * 3], cy0 = positions[c0 * 3 + 1], cz0 = positions[c0 * 3 + 2];
    
    const abx = bx0 - ax0, aby = by0 - ay0, abz = bz0 - az0;
    const acx = cx0 - ax0, acy = cy0 - ay0, acz = cz0 - az0;
    const beforeX = aby * acz - abz * acy;
    const beforeY = abz * acx - abx * acz;
    const beforeZ = abx * acy - aby * acx;
    const beforeLen = Math.hypot(beforeX, beforeY, beforeZ);
    if (beforeLen < 1e-10) return false;

    const a1 = a0 === b ? a : a0;
    const b1 = b0 === b ? a : b0;
    const c1 = c0 === b ? a : c0;
    if (a1 === b1 || b1 === c1 || a1 === c1) continue;

    const ax1 = a1 === a ? nx : positions[a1 * 3];
    const ay1 = a1 === a ? ny : positions[a1 * 3 + 1];
    const az1 = a1 === a ? nz : positions[a1 * 3 + 2];
    const bx1 = b1 === a ? nx : positions[b1 * 3];
    const by1 = b1 === a ? ny : positions[b1 * 3 + 1];
    const bz1 = b1 === a ? nz : positions[b1 * 3 + 2];
    const cx1 = c1 === a ? nx : positions[c1 * 3];
    const cy1 = c1 === a ? ny : positions[c1 * 3 + 1];
    const cz1 = c1 === a ? nz : positions[c1 * 3 + 2];

    const abx1 = bx1 - ax1, aby1 = by1 - ay1, abz1 = bz1 - az1;
    const acx1 = cx1 - ax1, acy1 = cy1 - ay1, acz1 = cz1 - az1;
    const afterX = aby1 * acz1 - abz1 * acy1;
    const afterY = abz1 * acx1 - abx1 * acz1;
    const afterZ = abx1 * acy1 - aby1 * acx1;
    const afterLen = Math.hypot(afterX, afterY, afterZ);
    if (afterLen < 1e-10) return false;

    const dot = (beforeX * afterX + beforeY * afterY + beforeZ * afterZ) / (beforeLen * afterLen);
    if (dot < 0.15) return false;
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
  const triangles: number[][] = new Array(originalTriangles);
  for (let i = 0; i < originalTriangles; i++) {
    const base = i * 3;
    triangles[i] = [mesh.indices[base], mesh.indices[base + 1], mesh.indices[base + 2]];
  }

  const numVertices = positions.length / 3;
  const aliveVertices = new Uint8Array(numVertices);
  aliveVertices.fill(1);
  
  const quadrics: Quadric[] = new Array(numVertices);
  for (let i = 0; i < numVertices; i++) quadrics[i] = emptyQuadric();
  
  const vertexTriangles: number[][] = new Array(numVertices);
  for (let i = 0; i < numVertices; i++) vertexTriangles[i] = [];

  const edgeMap = new Map<number, number>();
  const edges: number[] = [];

  const originalTrianglesCount = triangles.length;

  for (let t = 0; t < originalTrianglesCount; t++) {
    const [a, b, c] = triangles[t];
    vertexTriangles[a].push(t);
    vertexTriangles[b].push(t);
    vertexTriangles[c].push(t);

    const normal = triangleNormal(positions, a, b, c);
    const len = Math.hypot(...normal);
    if (len > 1e-12) {
      const nx = normal[0] / len, ny = normal[1] / len, nz = normal[2] / len;
      const d = -(nx * positions[a * 3] + ny * positions[a * 3 + 1] + nz * positions[a * 3 + 2]);
      const q = planeQuadric(nx, ny, nz, d, 1);
      quadrics[a] = addQuadric(quadrics[a], q);
      quadrics[b] = addQuadric(quadrics[b], q);
      quadrics[c] = addQuadric(quadrics[c], q);
    }

    const addEdge = (u: number, v: number) => {
      const key = (u < v ? (u << 16) | v : (v << 16) | u);
      const count = (edgeMap.get(key) ?? 0) + 1;
      edgeMap.set(key, count);
      if (count === 1) edges.push(key);
    };
    addEdge(a, b); addEdge(b, c); addEdge(c, a);
  }

  if (options.preserveBorders) {
    const borderWeight = options.quality === 'ultra' ? 100 : options.quality === 'high' ? 35 : options.quality === 'medium' ? 12 : options.quality === 'speed' ? 8 : 4;
    for (const key of edgeMap.keys()) {
      if (edgeMap.get(key) !== 1) continue;
      const a = key >>> 16, b = key & 0xFFFF;
      const neighbors = vertexTriangles[a];
      let neighborIdx = -1;
      for (let i = 0; i < neighbors.length; i++) {
        if (triangles[neighbors[i]].includes(b)) { neighborIdx = neighbors[i]; break; }
      }
      if (neighborIdx === -1) continue;
      
      const normal = triangleNormal(positions, ...triangles[neighborIdx]);
      const len = Math.hypot(...normal);
      if (!len) continue;
      const nx = normal[0] / len, ny = normal[1] / len, nz = normal[2] / len;
      const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
      const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
      const ex = bx - ax, ey = by - ay, ez = bz - az;
      const edgeNormalX = ey * normal[2] - ez * normal[1];
      const edgeNormalY = ez * normal[0] - ex * normal[2];
      const edgeNormalZ = ex * normal[1] - ey * normal[0];
      const el = Math.hypot(edgeNormalX, edgeNormalY, edgeNormalZ);
      if (el) {
        const d = -(edgeNormalX * ax + edgeNormalY * ay + edgeNormalZ * az) / el;
        const q = planeQuadric(edgeNormalX / el, edgeNormalY / el, edgeNormalZ / el, d, borderWeight);
        quadrics[a] = addQuadric(quadrics[a], q);
        quadrics[b] = addQuadric(quadrics[b], q);
      }
    }
  }

  const detailPenalty = options.protectDetails ? (options.quality === 'ultra' ? 1.8 : options.quality === 'high' ? 1.35 : options.quality === 'speed' ? 1.2 : 1.1) : 1;
  const dotThreshold = options.quality === 'ultra' ? 0.15 : options.quality === 'high' ? 0.15 : options.quality === 'speed' ? 0.1 : 0.05;
  const progressInterval = options.quality === 'ultra' ? 50 : options.quality === 'high' ? 25 : options.quality === 'speed' ? 100 : 25;

  const heap = new MinHeap();
  const pushEdge = (a: number, b: number) => {
    if (a === b || !aliveVertices[a] || !aliveVertices[b]) return;
    const q = addQuadric(quadrics[a], quadrics[b]);
    const pa: [number, number, number] = [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]];
    const pb: [number, number, number] = [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]];
    const position = optimalPosition(q, pa, pb);
    heap.push({ a, b, position, cost: evaluate(q, position) * detailPenalty });
  };

  for (const key of edges) {
    const a = key >>> 16, b = key & 0xFFFF;
    pushEdge(a, b);
  }

  let activeTriangles = triangles.length;
  let iterations = 0;
  const maxIterations = Math.max(1000, originalTrianglesCount * 3);
  const originalCount = triangles.length;
  const targetTris = target;

  const affected: number[] = [];

  while (activeTriangles > target && iterations < maxIterations) {
    iterations++;
    const candidate = heap.pop();
    if (!candidate) break;
    const { a, b, position } = candidate;
    if (!aliveVertices[a] || !aliveVertices[b]) continue;
    
    const key = a < b ? (a << 16) | b : (b << 16) | a;
    if (!edgeMap.has(key)) continue;

    affected.length = 0;
    for (const t of vertexTriangles[a]) affected.push(t);
    for (const t of vertexTriangles[b]) affected.push(t);
    
    if (!canCollapseFast(positions, triangles, affected, a, b, position, dotThreshold)) continue;

    const touchedEdges: number[] = [];
    for (let i = 0, len = affected.length; i < len; i++) {
      const tri = triangles[affected[i]];
      const a0 = tri[0], b0 = tri[1], c0 = tri[2];
      const addTouched = (u: number, v: number) => touchedEdges.push(u < v ? (u << 16) | v : (v << 16) | u);
      addTouched(tri[0], tri[1]); addTouched(tri[1], tri[2]); addTouched(tri[2], tri[0]);
    }
    
    for (const key of touchedEdges) edgeMap.delete(key);
    
    positions[a * 3] = position[0]; positions[a * 3 + 1] = position[1]; positions[a * 3 + 2] = position[2];
    quadrics[a] = addQuadric(quadrics[a], quadrics[b]);
    aliveVertices[b] = 0;

    for (let i = 0, len = affected.length; i < len; i++) {
      const t = affected[i];
      const tri = triangles[t];
      const a0 = tri[0], b0 = tri[1], c0 = tri[2];
      triangles[t] = [a0 === b ? a : a0, b0 === b ? a : b0, c0 === b ? a : c0];
      
      const updated = triangles[t];
      if (updated[0] === updated[1] || updated[1] === updated[2] || updated[0] === updated[2]) {
        if (triangles[t][0] !== -1) activeTriangles--;
        triangles[t] = [-1, -1, -1];
        continue;
      }
      
      const addTouched = (u: number, v: number) => {
        const key = u < v ? (u << 16) | v : (v << 16) | u;
        edgeMap.set(key, (edgeMap.get(key) ?? 0) + 1);
      };
      addTouched(updated[0], updated[1]);
      addTouched(updated[1], updated[2]);
      addTouched(updated[2], updated[0]);
      
      for (const v of updated) vertexTriangles[v].push(affected.indexOf(t));
    }

    if (iterations % progressInterval === 0) {
      const progress = 1 - (activeTriangles - target) / Math.max(1, originalTrianglesCount - target);
      onProgress?.(Math.min(0.99, Math.max(0, progress)));
    }
  }

  let outputTriangles: number[] = [];
  for (const tri of triangles) {
    if (tri[0] >= 0 && tri[1] >= 0 && tri[2] >= 0 && tri[0] !== tri[1] && tri[1] !== tri[2] && tri[0] !== tri[2]) {
      outputTriangles.push(tri[0], tri[1], tri[2]);
    }
  }

  if (outputTriangles.length / 3 > target) {
    const source = outputTriangles;
    const sourceCount = source.length / 3;
    const fallback: number[] = [];
    for (let i = 0; i < target; i++) {
      const at = Math.min(sourceCount - 1, Math.floor((i * sourceCount) / target));
      fallback.push(source[at * 3], source[at * 3 + 1], source[at * 3 + 2]);
    }
    outputTriangles = fallback;
  }

  const validOutputTriangles: number[] = [];
  for (let i = 0; i < outputTriangles.length; i += 3) {
    const a = outputTriangles[i], b = outputTriangles[i + 1], c = outputTriangles[i + 2];
    if (
      a !== b && b !== c && a !== c &&
      Number.isFinite(positions[a * 3]) &&
      triangleAreaSquared(positions, [a, b, c], 0) > 1e-12
    ) {
      validOutputTriangles.push(a, b, c);
    }
  }

  const compact = compactMesh(positions, validOutputTriangles, mesh.format);
  return {
    positions: compact.positions,
    indices: compact.indices,
    triangles: compact.indices.length / 3,
    vertices: compact.positions.length / 3,
    reductionPercent: ((originalTrianglesCount - compact.indices.length / 3) / originalTrianglesCount) * 100,
    warnings: activeTriangles > target ? ['A malha exigiu uma amostragem de segurança para respeitar o limite máximo de triângulos.'] : [],
  };
}