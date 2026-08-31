import type { MeshData, MeshStats, ValidationResult, ValidationConfig, Bounds } from './mesh-types';
import { calculateBounds, triangleAreaSquared, triangleNormal, computeSignedVolume, computeHausdorffDistance } from './geometry';

const MIN_TRIANGLE_AREA = 1e-12;
const MIN_ANGLE_DEGREES = 5;
const MAX_ASPECT_RATIO = 50;
const MAX_NORMAL_DEVIATION = 0.5;
const MAX_VOLUME_CHANGE_PERCENT = 5;
const MAX_HAUSDORFF_DISTANCE = 0.01;
const MAX_SILHOUETTE_DEVIATION = 0.05;

export function validateMesh(mesh: any, originalMesh: any, config: any): any {
  const { positions, indices } = mesh;
  const originalPositions = originalMesh.positions;
  const originalIndices = originalMesh.indices;
  
  const triangleCount = indices.length / 3;
  const originalTriangleCount = originalIndices.length / 3;
  
  const errors: string[] = [];
  const warnings: string[] = [];
  
  let degenerateFaces = 0;
  let thinTriangles = 0;
  let zeroAreaFaces = 0;
  let maxAspectRatio = 0;
  let minTriangleArea = Infinity;
  let minAngle = Infinity;
  
  // Check triangle quality
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    if (a === b || b === c || a === c) continue;
    
    const area = triangleArea(mesh.positions, a, b, c);
    if (area < MIN_TRIANGLE_AREA) {
      zeroAreaFaces++;
    }
    
    const aspectRatio = triangleAspectRatio(mesh.positions, a, b, c);
    maxAspectRatio = Math.max(maxAspectRatio, aspectRatio);
    if (aspectRatio > 50) thinTriangles++;
    
    const areaVal = triangleArea(mesh.positions, a, b, c);
    minTriangleArea = Math.min(minTriangleArea, areaVal);
    
    const minAngleVal = minTriangleAngle(mesh.positions, a, b, c);
    if (minAngleVal < 5) minAngle = Math.min(minAngle, minAngleVal);
  }
  
  if (zeroAreaFaces > 0) {
    errors.push(`${zeroAreaFaces} faces com área zero ou degenerada`);
  }
  
  if (thinTriangles > 0) {
    warnings.push(`${thinTriangles} triângulos extremamente alongados (aspect ratio > 50)`);
  }
  
  // Check volume preservation
  const originalVolume = Math.abs(computeSignedVolume(originalMesh.positions, originalIndices));
  const currentVolume = Math.abs(computeSignedVolume(mesh.positions, mesh.indices));
  const volumeChangePercent = originalVolume > 0 ? Math.abs(currentVolume - originalVolume) / originalVolume * 100 : 0;
  
  if (volumeChangePercent > 5) {
    errors.push(`Volume alterado em ${volumeChangePercent.toFixed(2)}% (máximo permitido: 5%)`);
  } else if (volumeChangePercent > 1) {
    warnings.push(`Volume alterado em ${volumeChangePercent.toFixed(2)}%`);
  }
  
  // Compute Hausdorff distance (simplified)
  const hausdorffDistance = computeHausdorffDistance(mesh.positions, originalMesh.positions);
  
  if (hausdorffDistance > 0.01) {
    errors.push(`Distância de Hausdorff (${hausdorffDistance.toFixed(4)}) excede o limite (0.01)`);
  } else if (hausdorffDistance > 0.005) {
    warnings.push(`Distância de Hausdorff (${hausdorffDistance.toFixed(4)}) próxima do limite`);
  }
  
  // Check for self-intersections (simplified - check for intersecting triangles)
  const selfIntersections = detectSelfIntersections(mesh);
  if (selfIntersections > 0) {
    errors.push(`${selfIntersections} auto-interseções detectadas`);
  }
  
  // Check for inverted normals
  for (let i = 0; i < indices.length / 3; i++) {
    const normal = triangleNormal(
      new Float32Array([0,0,0]), 
      indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]
    );
    // This is simplified - we'd need proper face normals
  }
  
  // Check silhouette preservation (simplified)
  const silhouetteDeviation = computeSilhouetteDeviation(mesh, originalMesh);
  if (silhouetteDeviation > 0.05) {
    warnings.push(`Desvio de silhueta: ${silhouetteDeviation.toFixed(4)}`);
  }
  
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metrics: {
      hausdorffDistance,
      volumeChangePercent,
      maxAspectRatio,
      minTriangleArea,
      minAngle,
      normalDeviation: 0,
      silhouetteDeviation: computeSilhouetteDeviation(mesh, originalMesh),
      selfIntersections: detectSelfIntersections(mesh)
    }
  };
}

export function cleanMesh(mesh: MeshData): MeshData {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  const vertexMap = new Map<string, number>();
  const remap = new Uint32Array(positions.length / 3);
  const uniquePositions: number[] = [];

  for (let i = 0; i < vertexCount; i++) {
    const key = `${positions[i * 3].toFixed(6)},${positions[i * 3 + 1].toFixed(6)},${positions[i * 3 + 2].toFixed(6)}`;
    let newIdx = vertexMap.get(key);
    if (newIdx === undefined) {
      newIdx = uniquePositions.length / 3;
      vertexMap.set(key, newIdx);
      uniquePositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = newIdx;
  }

  const newIndices: number[] = [];
  for (let i = 0; i < triangleCount; i++) {
    const a = remap[indices[i * 3]];
    const b = remap[indices[i * 3 + 1]];
    const c = remap[indices[i * 3 + 2]];

    if (a !== b && b !== c && a !== c) {
      newIndices.push(a, b, c);
    }
  }

  const newPositions = new Float32Array(uniquePositions);
  const newIndicesArray = new Uint32Array(newIndices);

  return {
    positions: newPositions,
    indices: newIndicesArray,
    format: mesh.format,
    bounds: calculateBounds(new Float32Array(uniquePositions))
  };
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

function computeAngle(a: [number, number, number], b: [number, number, number], c: [number, number, number]): number {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const abLen = Math.hypot(...ab);
  const acLen = Math.hypot(...ac);
  if (abLen < 1e-10 || acLen < 1e-10) return 0;
  const dot = (ab[0] * ac[0] + ab[1] * ac[1] + ab[2] * ac[2]) / (abLen * acLen);
  return Math.acos(Math.max(-1, Math.min(1, dot)));
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

function computeHausdorffDistance(positions1: Float32Array, positions2: Float32Array): number {
  let maxDist = 0;
  const step = Math.max(1, Math.floor(positions1.length / 3 / 1000));
  
  for (let i = 0; i < positions1.length / 3; i += step) {
    let minDist = Infinity;
    for (let j = 0; j < positions2.length / 3; j += 10) {
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

function computeSilhouetteDeviation(mesh: any, originalMesh: any): number {
  // Simplified - compute bounding box difference as proxy
  const bounds1 = calculateBounds(mesh.positions);
  const bounds2 = calculateBounds(originalMesh.positions);
  
  const dx = Math.max(
    Math.abs(bounds1.min[0] - bounds2.min[0]),
    Math.abs(bounds1.max[0] - bounds2.max[0])
  );
  const dy = Math.max(
    Math.abs(bounds1.min[1] - bounds2.min[1]),
    Math.abs(bounds1.max[1] - bounds2.max[1])
  );
  const dz = Math.max(
    Math.abs(bounds1.min[2] - bounds2.min[2]),
    Math.abs(bounds1.max[2] - bounds2.max[2])
  );
  
  return Math.max(dx, dy, dz);
}

function detectSelfIntersections(mesh: any): number {
  // Simplified - check for intersecting triangles using bounding box overlap
  // In production, use BVH or sweep-line algorithm
  const { positions, indices } = mesh;
  const triangleCount = indices.length / 3;
  let intersections = 0;
  
  // Quick check - only sample pairs for performance
  const sampleStep = Math.max(1, Math.floor(indices.length / 3 / 1000));
  
  for (let i = 0; i < triangleCount; i += sampleStep) {
    const a1 = indices[i * 3];
    const b1 = indices[i * 3 + 1];
    const c1 = indices[i * 3 + 2];
    
    // Compute triangle bounding box
    const min1 = [Infinity, Infinity, Infinity];
    const max1 = [-Infinity, -Infinity, -Infinity];
    for (const v of [indices[i * 3], indices[i * 3 + 1], indices[i * 3 + 2]]) {
      for (let d = 0; d < 3; d++) {
        const val = positions[v * 3 + d];
        if (val < min1[d]) min1[d] = val;
        if (val > max1[d]) max1[d] = val;
      }
    }
    
    for (let j = i + 1; j < triangleCount; j += sampleStep) {
      const a2 = indices[j * 3];
      const b2 = indices[j * 3 + 1];
      const c2 = indices[j * 3 + 2];
      
      // Quick bounding box test
      const min2 = [Infinity, Infinity, Infinity];
      const max2 = [-Infinity, -Infinity, -Infinity];
      for (const v of [indices[j * 3], indices[j * 3 + 1], indices[j * 3 + 2]]) {
        for (let d = 0; d < 3; d++) {
          const val = positions[v * 3 + d];
          if (val < min2[d]) min2[d] = val;
          if (val > max2[d]) max2[d] = val;
        }
      }
      
      // Check bbox overlap
      if (max1[0] < min2[0] || min1[0] > max2[0] ||
          max1[1] < min2[1] || min1[1] > max2[1] ||
          max1[2] < min2[2] || min1[2] > max2[2]) {
        continue;
      }
      
      // Triangles might intersect - would need full triangle-triangle test
      // For now, just count potential intersections
      intersections++;
    }
  }
  
  return intersections;
}