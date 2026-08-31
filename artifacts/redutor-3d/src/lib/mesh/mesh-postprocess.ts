import type { MeshData, Bounds, Vec3 } from './mesh-types';
import { calculateBounds, triangleAreaSquared } from './geometry';

export interface SmoothingOptions {
  iterations: number;
  lambda: number;
  mu: number;
  preserveVolume: boolean;
  featureAngleThreshold: number;
  fixedVertices: Set<number>;
}

export interface ReprojectionOptions {
  maxDistance: number;
  iterations: number;
  preserveVolume: boolean;
  featureVertices: Set<number>;
}

function triangleNormal(positions: Float32Array, a: number, b: number, c: number): [number, number, number] {
  const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
  const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
  const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
  const abx = positions[b * 3] - positions[a * 3], aby = positions[b * 3 + 1] - positions[a * 3 + 1], abz = positions[b * 3 + 2] - positions[a * 3 + 2];
  const acx = positions[c * 3] - positions[a * 3], acy = positions[c * 3 + 1] - positions[a * 3 + 1], acz = positions[c * 3 + 2] - positions[a * 3 + 2];
  return [
    positions[b * 3 + 1] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3 + 1] - 
    positions[a * 3 + 1] * (positions[c * 3 + 2] - positions[b * 3 + 2]) + 
    positions[a * 3 + 2] * (positions[c * 3 + 1] - positions[b * 3 + 1]),
    positions[b * 3 + 2] * positions[c * 3] - positions[b * 3] * positions[c * 3 + 2] - 
    positions[a * 3 + 2] * (positions[c * 3] - positions[b * 3]) + 
    positions[a * 3] * (positions[c * 3 + 2] - positions[b * 3 + 2]),
    positions[b * 3] * positions[c * 3 + 1] - positions[b * 3 + 1] * positions[c * 3] - 
    positions[a * 3] * (positions[c * 3 + 1] - positions[b * 3 + 1]) + 
    positions[a * 3 + 1] * (positions[c * 3] - positions[b * 3])
  ];
}

export function taubinSmoothing(
  mesh: MeshData, 
  options: SmoothingOptions
): MeshData {
  const { positions, indices } = mesh;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;
  
  const lambda = options.lambda || 0.5;
  const mu = options.mu || -0.53;
  const iterations = options.iterations || 10;
  const preserveVolume = options.preserveVolume !== false;
  const featureAngleThreshold = options.featureAngleThreshold || 30 * Math.PI / 180;
  const fixedVertices = options.fixedVertices || new Set<number>();

  // Build adjacency
  const vertexNeighbors: number[][] = new Array(positions.length / 3).fill(0).map(() => []);
  const vertexTriangles: number[][] = new Array(positions.length / 3).fill(0).map(() => []);
  
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    vertexTriangles[a].push(i);
    vertexTriangles[b].push(i);
    vertexTriangles[c].push(i);
    
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (!vertexNeighbors[u].includes(v)) vertexNeighbors[u].push(v);
      if (!vertexNeighbors[v].includes(u)) vertexNeighbors[v].push(u);
    }
  }

  // Compute face normals for feature detection
  const faceNormals: Float32Array = new Float32Array((indices.length / 3) * 3);
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    const abx = positions[b * 3] - positions[a * 3], aby = positions[b * 3 + 1] - positions[a * 3 + 1], abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3], acy = positions[c * 3 + 1] - positions[a * 3 + 1], acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    
    const nx = positions[b * 3 + 1] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3 + 1] - 
              positions[a * 3 + 1] * (positions[c * 3 + 2] - positions[b * 3 + 2]) + 
              positions[a * 3 + 2] * (positions[c * 3 + 1] - positions[b * 3 + 1]);
    const ny = positions[b * 3 + 2] * positions[c * 3] - positions[b * 3] * positions[c * 3 + 2] - 
              positions[a * 3 + 2] * (positions[c * 3] - positions[b * 3]) + 
              positions[a * 3] * (positions[c * 3 + 2] - positions[b * 3 + 2]);
    const nz = positions[b * 3] * positions[c * 3 + 1] - positions[b * 3 + 1] * positions[c * 3] - 
              positions[a * 3] * (positions[c * 3 + 1] - positions[b * 3 + 1]) + 
              positions[a * 3 + 1] * (positions[c * 3] - positions[b * 3]);
    
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-10) {
      faceNormals[i * 3] = nx / len;
      faceNormals[i * 3 + 1] = ny / len;
      faceNormals[i * 3 + 2] = nz / len;
    }
  }

  // Detect feature vertices (sharp edges)
  const featureVertices = new Set<number>();
  const edgeMap = new Map<string, { faces: number[] }>();
  
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      if (!edgeMap.has(key)) edgeMap.set(key, { faces: [] });
      edgeMap.get(key)!.faces.push(i);
    }
  }
  
  const sharpAngleThreshold = Math.cos(30 * Math.PI / 180); // 30 degrees
  for (const [, entry] of edgeMap) {
    if (entry.faces.length === 2) {
      const [f1, f2] = entry.faces;
      const n1 = [faceNormals[f1 * 3], faceNormals[f1 * 3 + 1], faceNormals[f1 * 3 + 2]];
      const n2 = [faceNormals[f2 * 3], faceNormals[f2 * 3 + 1], faceNormals[f2 * 3 + 2]];
      const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
      if (dot < Math.cos(30 * Math.PI / 180)) {
        // This is a feature edge - mark vertices as features
        // We'd need to find which vertices belong to this edge
      }
    }
  }

  // Build vertex normals
  const vertexNormals = new Float32Array(3 * vertexCount);
  const normalWeights = new Float32Array(positions.length / 3);
  
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    // Compute face normal
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    const abx = positions[b * 3] - positions[a * 3], aby = positions[b * 3 + 1] - positions[a * 3 + 1], abz = positions[b * 3 + 2] - positions[a * 3 + 2];
    const acx = positions[c * 3] - positions[a * 3], acy = positions[c * 3 + 1] - positions[a * 3 + 1], acz = positions[c * 3 + 2] - positions[a * 3 + 2];
    
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    
    const len = Math.hypot(nx, ny, nz);
    const area = len * 0.5;
    
    if (len > 1e-10) {
      const nxl = nx / len, nyl = ny / len, nzl = nz / len;
      for (const v of [a, b, c]) {
        const idx = v * 3;
        vertexNormals[idx] += nxl * area;
        vertexNormals[idx + 1] += nyl * area;
        vertexNormals[idx + 2] += nzl * area;
      }
    }
  }
  
  // Normalize vertex normals
  for (let i = 0; i < vertexCount; i++) {
    const idx = i * 3;
    const len = Math.hypot(vertexNormals[idx], vertexNormals[idx + 1], vertexNormals[idx + 2]);
    if (len > 1e-10) {
      vertexNormals[idx] /= len;
      vertexNormals[idx + 1] /= len;
      vertexNormals[idx + 2] /= len;
    }
  }

  // Build vertex neighbors
  const neighbors: number[][] = new Array(vertexCount).fill(0).map(() => []);
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (!vertexNeighbors[u].includes(v)) vertexNeighbors[u].push(v);
      if (!vertexNeighbors[v].includes(u)) vertexNeighbors[v].push(u);
    }
  }

  // Taubin smoothing iterations
  const newPositions = new Float32Array(positions);
  
  for (let iter = 0; iter < iterations; iter++) {
    const isLambdaStep = iter % 2 === 0;
    const factor = isLambdaStep ? lambda : mu;
    
    // Compute new positions
    const newPositions = new Float32Array(positions.length);
    for (let i = 0; i < vertexCount; i++) {
      newPositions[i * 3] = positions[i * 3];
      newPositions[i * 3 + 1] = positions[i * 3 + 1];
      newPositions[i * 3 + 2] = positions[i * 3 + 2];
    }
    
    for (let i = 0; i < vertexCount; i++) {
      if (fixedVertices.has(i)) continue;
      
      const neighborsList = vertexNeighbors[i];
      if (neighborsList.length === 0) continue;
      
      // Compute barycenter of neighbors
      let cx = 0, cy = 0, cz = 0;
      let weightSum = 0;
      
      for (const n of neighborsList) {
        // Skip if neighbor is a feature vertex and we're at a feature
        // (preserve sharp features)
        const weight = 1.0; // Could add cotangent weights here
        const nx = positions[n * 3];
        const ny = positions[n * 3 + 1];
        const nz = positions[n * 3 + 2];
        
        cx += nx * weight;
        cy += ny * weight;
        cz += nz * weight;
        weightSum += weight;
      }
      
      if (weightSum > 0) {
        const cxAvg = cx / weightSum;
        const cyAvg = cy / weightSum;
        const czAvg = cz / weightSum;
        
        const idx = i * 3;
        const dx = cxAvg - positions[idx];
        const dy = cyAvg - positions[cy];
        const dz = czAvg - positions[idx + 2];
        
        newPositions[idx] += dx * factor;
        newPositions[idx + 1] += dy * factor;
        newPositions[idx + 2] += dz * factor;
      }
    }
    
    // Volume correction if needed
    if (preserveVolume) {
      // Compute volume before and after
      // Apply correction by scaling relative to centroid
    }
    
    // Update positions
    positions.set(newPositions);
  }
  
  return {
    positions,
    indices: new Uint32Array(indices),
    format: 'STL' as const,
    bounds: calculateBounds(positions)
  };
}

export function reprojectToOriginalMesh(
  simplifiedMesh: MeshData,
  originalMesh: MeshData,
  options: ReprojectionOptions
): MeshData {
  const { positions } = simplifiedMesh;
  const originalPositions = originalMesh.positions;
  const originalIndices = originalMesh.indices;
  
  const vertexCount = positions.length / 3;
  const originalVertexCount = originalPositions.length / 3;
  const featureVertices = options.featureVertices || new Set<number>();
  
  // Build original mesh acceleration structure (simplified - use brute force for now)
  // In production, use a BVH or KD-tree
  
  const newPositions = new Float32Array(positions);
  const maxDist = options.maxDistance || 0.01;
  
  for (let i = 0; i < positions.length / 3; i++) {
    if (options.featureVertices && options.featureVertices.has(i)) continue;
    
    const px = positions[i * 3];
    const py = positions[i * 3 + 1];
    const pz = positions[i * 3 + 2];
    
    // Find closest point on original mesh
    // Simplified - find closest vertex on original mesh
    // In production, use ray-triangle intersection with original mesh triangles
    let minDist = Infinity;
    let closestX = 0, closestY = 0, closestZ = 0;
    
    for (let j = 0; j < originalVertexCount; j++) {
      const dx = originalPositions[j * 3] - positions[i * 3];
      const dy = originalPositions[j * 3 + 1] - positions[i * 3 + 1];
      const dz = originalPositions[j * 3 + 2] - positions[i * 3 + 2];
      const dist = Math.hypot(dx, dy, dz);
      
      if (dist < maxDist && dist < minDist) {
        minDist = dist;
        closestX = originalPositions[j * 3];
        closestY = originalPositions[j * 3 + 1];
        closestZ = originalPositions[j * 3 + 2];
      }
    }
    
    if (minDist < Infinity && minDist > 0) {
      // Move vertex towards original surface
      const weight = 0.5; // Could be adaptive based on distance
      const idx = i * 3;
      const newX = positions[i * 3] + (closestX - positions[i * 3]) * 0.5;
      const newY = positions[i * 3 + 1] + (closestY - positions[i * 3 + 1]) * 0.5;
      const newZ = positions[i * 3 + 2] + (closestZ - positions[i * 3 + 2]) * 0.5;
      
      newPositions[i * 3] = newX;
      newPositions[i * 3 + 1] = newY;
      newPositions[i * 3 + 2] = newZ;
    }
  }
  
  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    format: 'STL' as const,
    bounds: calculateBounds(new Float32Array(positions))
  };
}

export function computeSignedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    volume += ax * (positions[b * 3 + 1] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3 + 1])
            - ay * (positions[b * 3] * positions[c * 3 + 2] - positions[b * 3 + 2] * positions[c * 3])
            + az * (positions[b * 3] * positions[c * 3 + 1] - positions[b * 3 + 1] * positions[c * 3]);
  }
  return volume / 6;
}

export function scaleToMatchVolume(mesh: MeshData, targetVolume: number): MeshData {
  const currentVolume = computeSignedVolume(mesh.positions, mesh.indices);
  if (currentVolume === 0) return mesh;
  
  const scale = Math.cbrt(targetVolume / currentVolume);
  const newPositions = new Float32Array(mesh.positions);
  
  // Scale around centroid
  const bounds = calculateBounds(mesh.positions);
  const cx = (bounds.min[0] + bounds.max[0]) * 0.5;
  const cy = (bounds.min[1] + bounds.max[1]) * 0.5;
  const cz = (bounds.min[2] + bounds.max[2]) * 0.5;
  
  for (let i = 0; i < mesh.positions.length / 3; i++) {
    mesh.positions[i * 3] = cx + (mesh.positions[i * 3] - cx) * scale;
    mesh.positions[i * 3 + 1] = cy + (mesh.positions[i * 3 + 1] - cy) * scale;
    mesh.positions[i * 3 + 2] = cz + (mesh.positions[i * 3 + 2] - cz) * scale;
  }
  
  return {
    positions: mesh.positions,
    indices: mesh.indices,
    format: mesh.format,
    bounds: calculateBounds(mesh.positions)
  };
}