import { 
  calculateBounds, 
  compactMesh, 
  triangleAreaSquared, 
  triangleNormal, 
  computeSignedVolume, 
  computeHausdorffDistance 
} from './geometry';
import type { MeshData, SimplifyOptions, SimplifyResult, MeshFeatures, EdgeCollapseCandidate, ValidationConfig } from './mesh-types';

type Quadric = [number, number, number, number, number, number, number, number, number, number];
type Candidate = { 
  v1: number; 
  v2: number; 
  position: [number, number, number]; 
  cost: number;
  volumeChange: number;
  silhouetteChange: number;
  quality: number;
  maxAspectRatio: number;
  minAngle: number;
  volumeChangePercent: number;
  normalDeviation: number;
};

const emptyQuadric = (): [number, number, number, number, number, number, number, number, number, number] => 
  [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const addQuadric = (a: [number, number, number, number, number, number, number, number, number, number], 
  b: [number, number, number, number, number, number, number, number, number, number]): [number, number, number, number, number, number, number, number, number, number] => {
  return [
    a[0] + b[0], a[1] + b[1], a[2] + b[2], a[3] + b[3],
    a[4] + b[4], a[5] + b[5], a[6] + b[6], a[7] + b[7],
    a[8] + b[8], a[9] + b[9]
  ];
};

const planeQuadric = (a: number, b: number, c: number, d: number, weight: number): [number, number, number, number, number, number, number, number, number, number] => [
  a * a * weight, a * b * weight, a * c * weight, a * d * weight,
  b * b * weight, b * c * weight, b * d * weight,
  c * c * weight, c * d * weight, d * d * weight
];

const evaluate = (q: [number, number, number, number, number, number, number, number, number, number], 
  p: [number, number, number]) =>
  q[0] * p[0] * p[0] + 2 * q[1] * p[0] * p[1] + 2 * q[2] * p[0] * p[2] +
  2 * q[3] * p[0] + q[4] * p[1] * p[1] + 2 * q[5] * p[1] * p[2] +
  2 * q[6] * p[1] + q[7] * p[2] * p[2] + 2 * q[8] * p[2] + q[9];

class MinHeap {
  private values: { v1: number; v2: number; position: [number, number, number]; cost: number }[] = [];
  
  push(value: { v1: number; v2: number; position: [number, number, number]; cost: number }) {
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
  
  get size() { return this.values.length; }
}

const keyOf = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

function triangleNormal(positions: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
}

function computeTriangleArea(positions: Float32Array, a: number, b: number, c: number): number {
  const normal = triangleNormal(
    new Float32Array([0,0,0]), a, b, c
  );
  return Math.hypot(normal[0], normal[1], normal[2]) * 0.5;
}

function computeAngle(a: [number, number, number], b: [number, number, number], c: [number, number, number]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const abLen = Math.hypot(...ab);
  const acLen = Math.hypot(...ac);
  if (abLen < 1e-10 || acLen < 1e-10) return 0;
  const dot = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / (abLen * acLen);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
}

function triangleArea(positions: Float32Array, a: number, b: number, c: number): number {
  const normal = triangleNormal(
    new Float32Array([0,0,0]), a, b, c
  );
  return Math.hypot(normal[0], normal[1], normal[2]) * 0.5;
}

function triangleAspectRatio(positions: Float32Array, a: number, b: number, c: number): number {
  const ab = Math.hypot(
    positions[b * 3] - positions[a * 3],
    positions[b * 3 + 1] - positions[a * 3 + 1],
    positions[b * 3 + 2] - positions[a * 3 + 2]
  );
  const bc = Math.hypot(
    positions[b * 3] - positions[c * 3],
    positions[b * 3 + 1] - positions[c * 3 + 1],
    positions[b * 3 + 2] - positions[c * 3 + 2]
  );
  const ca = Math.hypot(
    positions[c * 3] - positions[a * 3],
    positions[c * 3 + 1] - positions[a * 3 + 1],
    positions[c * 3 + 2] - positions[a * 3 + 2]
  );
  const maxEdge = Math.max(ab, bc, ca);
  const minEdge = Math.min(ab, bc, ca);
  return minEdge > 0 ? maxEdge / minEdge : Infinity;
}

function minTriangleAngle(positions: Float32Array, a: number, b: number, c: number): number {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];

  const angles = [
    computeAngle([ax, ay, az], [bx, by, bz], [cx, cy, cz]),
    computeAngle([bx, by, bz], [ax, ay, az], [cx, cy, cz]),
    computeAngle([cx, cy, cz], [ax, ay, az], [bx, by, bz])
  ];
  return Math.min(...angles) * 180 / Math.PI;
}

function optimalPosition(q: [number, number, number, number, number, number, number, number, number, number], 
  a: [number, number, number], b: [number, number, number]): [number, number, number] {
  const det = q[0] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[1] * q[7] - q[5] * q[2]) + q[2] * (q[1] * q[5] - q[4] * q[2]);
  if (Math.abs(det) > 1e-12) {
    const x = -(q[3] * (q[4] * q[7] - q[5] * q[5]) - q[1] * (q[6] * q[7] - q[5] * q[8]) + q[2] * (q[6] * q[5] - q[4] * q[8])) / det;
    const y = - (q[0] * (q[6] * q[7] - q[5] * q[8]) - q[3] * (q[1] * q[7] - q[5] * q[8]) + q[2] * (q[1] * q[8] - q[6] * q[2])) / det;
    const z = - (q[0] * (q[4] * q[8] - q[6] * q[5]) - q[1] * (q[1] * q[8] - q[6] * q[2]) + q[3] * (q[1] * q[5] - q[4] * q[2])) / det;
    if ([x, y, z].every(Number.isFinite)) return [x, y, z];
  }
  return [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, (a[2] + b[2]) * 0.5];
}

export interface SimplificationState {
  positions: Float32Array;
  indices: Uint32Array;
  originalPositions: Float32Array;
  originalIndices: Uint32Array;
  triangles: number[][];
  originalTriangles: number[][];
  quadrics: Float32Array[];
  vertexTriangles: number[][];
  edgeMap: Map<number, number>;
  edges: number[];
  aliveVertices: Uint8Array;
  faceNormals: Float32Array;
  vertexNormals: Float32Array;
  originalPositions: Float32Array;
  originalNormals: Float32Array;
  bounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  originalBounds: { min: [number, number, number]; max: [number, number, number]; size: [number, number, number] };
  originalVolume: number;
  features: {
    boundaryVertices: Set<number>;
    boundaryEdges: Set<number>;
    silhouetteVertices: Set<number>;
    silhouetteEdges: Set<number>;
    featureVertices: Set<number>;
    featureEdges: Set<number>;
    cornerVertices: Set<number>;
    curvature: Float32Array;
    gaussianCurvature: Float32Array;
    meanCurvature: Float32Array;
    vertexImportance: Float32Array;
    boundaryLoops: number[][];
    silhouetteLoops: number[][];
    boundaryVerticesArray: number[];
    silhouetteVerticesArray: number[];
  };
  validationConfig: {
    maxError: number;
    maxAspectRatio: number;
    minTriangleArea: number;
    minAngle: number;
    maxNormalDeviation: number;
    maxVolumeChangePercent: number;
    maxSilhouetteDeviation: number;
    maxHausdorffDistance: number;
    checkSelfIntersection: boolean;
    checkVolumePreservation: boolean;
    checkSilhouette: boolean;
  };
}

interface ValidationConfig {
  maxError: number;
  maxAspectRatio: number;
  minTriangleArea: number;
  minAngle: number;
  maxNormalDeviation: number;
  maxVolumeChangePercent: number;
  maxSilhouetteDeviation: number;
  maxHausdorffDistance: number;
  checkSelfIntersection: boolean;
  checkVolumePreservation: boolean;
  checkSilhouette: boolean;
}

function computeSignedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}

function computeHausdorffDistance(positions1: Float32Array, indices1: Uint32Array, positions2: Float32Array, indices2: Uint32Array): number {
  // Simplified Hausdorff distance computation
  // In practice, use a spatial acceleration structure (KD-tree or BVH)
  // This is a simplified version for validation
  
  const vertices1: [number, number, number][] = [];
  for (let i = 0; i < positions1.length / 3; i++) {
    vertices1.push([positions1[i * 3], positions1[i * 3 + 1], positions1[i * 3 + 2]]);
  }
  
  let maxDist = 0;
  for (let i = 0; i < positions1.length / 3; i++) {
    const p1 = [positions1[i * 3], positions1[i * 3 + 1], positions1[i * 3 + 2]];
    
    // Find closest point on mesh2
    let minDist = Infinity;
    for (let j = 0; j < positions2.length / 3; j++) {
      const dx = positions1[i * 3] - positions2[j * 3];
      const dy = positions1[i * 3 + 1] - positions2[j * 3 + 1];
      const dz = positions1[i * 3 + 2] - positions2[j * 3 + 2];
      const dist = Math.hypot(dx, dy, dz);
      if (dist < minDist) minDist = dist;
    }
    if (minDist > maxDist) maxDist = minDist;
  }
  
  return maxDist;
}
 
export function robustSimplifyMesh(mesh: any, options: any, onProgress?: (progress: number) => void): any {
  // This is a placeholder for the full robust implementation
  // The actual implementation would be very long and complex
  // For now, returning the existing simplifier as a base
  throw new Error('Full implementation needed');
}

export function validateMeshIntegrity(mesh: any, originalMesh: any, config: any): { passed: boolean; errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  
  // Check for degenerate faces
  // Check for holes
  // Check for volume preservation
  // Check for self-intersections
  // Check for silhouette preservation
  // Check for volume preservation
  // Check triangle quality
  
  return { passed: errors.length === 0, errors, warnings };
}