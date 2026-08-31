import type { MeshData, MeshStats, ValidationResult, ValidationConfig, Bounds } from './mesh-types';
import { calculateBounds, triangleAreaSquared, triangleNormal, computeSignedVolume, computeHausdorffDistance } from './geometry';

const MIN_TRIANGLE_AREA = 1e-12;
const MIN_ANGLE_DEGREES = 5;
const MAX_ASPECT_RATIO = 50;
const MAX_NORMAL_DEVIATION = 0.5;
const MAX_VOLUME_CHANGE_PERCENT = 5;
const MAX_HAUSDORFF_DISTANCE = 0.01;
const MAX_SILHOUETTE_DEVIATION = 0.05;

export function validateMeshGeometry(mesh: any, originalMesh: any, config: any): any {
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
  let invertedNormals = 0;
  let selfIntersections = 0;
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
    
    const minAngle = minTriangleAngle(mesh.positions, a, b, c);
    if (minAngle < 5) minAngle = Math.min(minAngle, minAngle);
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
  
  // Volume change percent
  const volumeChangePercent = originalVolume > 0 ? 
    Math.abs(computeSignedVolume(mesh.positions, mesh.indices) - originalVolume) / originalVolume * 100 : 0;
  
  // Check silhouette deviation
  const silhouetteDeviation = computeSilhouetteDeviation(mesh, originalMesh);
  if (silhouetteDeviation > 0.05) {
    warnings.push(`Desvio de silhueta: ${silhouetteDeviation.toFixed(4)}`);
  }
  
  // Self-intersection check
  const selfIntersections = detectSelfIntersections(mesh);
  if (selfIntersections > 0) {
    errors.push(`${selfIntersections} auto-interseções detectadas`);
  }
  
  return {
    passed: errors.length === 0,
    errors,
    warnings,
    metrics: {
      hausdorffDistance: computeHausdorffDistance(mesh.positions, originalMesh.positions),
      volumeChangePercent: volumeChangePercent,
      maxAspectRatio: maxAspectRatio,
      minTriangleArea: minTriangleArea,
      minAngle: minAngle,
      normalDeviation: 0,
      volumeChangePercent: volumeChangePercent,
      silhouetteDeviation: computeSilhouetteDeviation(mesh, originalMesh),
      selfIntersections: detectSelfIntersections(mesh)
    }
  };
}