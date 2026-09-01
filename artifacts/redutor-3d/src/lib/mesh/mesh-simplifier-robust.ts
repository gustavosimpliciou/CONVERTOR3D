import { 
  calculateBounds, 
  compactMesh, 
  triangleAreaSquared, 
  triangleNormal, 
  computeSignedVolume, 
  computeHausdorffDistance 
} from './geometry';
import type { MeshData, SimplifyOptions, SimplifyResult, MeshFeatures } from './mesh-types';
import { validateMesh, cleanMesh } from './mesh-validation';
import { detectMeshFeatures } from './mesh-features';

export function robustSimplifyMesh(mesh: MeshData, options: SimplifyOptions, onProgress?: (progress: number) => void): any {
  const startTime = performance.now();
  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;
  
  // Step 1: Clean the mesh to remove degenerate faces (fast, deterministic)
  const cleaned = cleanMesh(mesh);
  let currentPositions = cleaned.positions;
  let currentIndices = cleaned.indices;
  const currentVertexCount = currentPositions.length / 3;
  const currentTriangleCount = currentIndices.length / 3;
  
  if (onProgress) onProgress(0.1);
  
  // Step 2: Determine target triangles
  const targetTriangles = options.targetTriangles || Math.max(1, currentTriangleCount / 2);
  const trianglesToRemove = currentTriangleCount - targetTriangles;
  
  // Quick check: if target is close to original, just return cleaned mesh
  if (trianglesToRemove <= 0) {
    return {
      positions: currentPositions,
      indices: currentIndices,
      format: cleaned.format,
      bounds: cleaned.bounds,
      processingTime: performance.now() - startTime,
      originalTriangleCount: triangleCount,
      finalTriangleCount: currentTriangleCount
    };
  }
  
  // Step 3: Compute vertex normals and degrees for priority
  const vertexDegree = new Float32Array(currentVertexCount);
  const vertexNormals = new Float32Array(currentPositions.length);
  const normalCounts = new Float32Array(currentVertexCount);
  
  for (let i = 0; i < currentTriangleCount; i++) {
    const a = currentIndices[i * 3];
    const b = currentIndices[i * 3 + 1];
    const c = currentIndices[i * 3 + 2];
    
    vertexDegree[a] += 1;
    vertexDegree[b] += 1;
    vertexDegree[c] += 1;
    
    const n = triangleNormal(currentPositions, a, b, c);
    const area = Math.hypot(n[0], n[1], n[2]) * 0.5;
    
    for (const v of [a, b, c]) {
      const idx = v * 3;
      vertexNormals[idx] += n[0] * area;
      vertexNormals[idx + 1] += n[1] * area;
      vertexNormals[idx + 2] += n[2] * area;
      normalCounts[v] += area;
    }
  }
  
  // Normalize vertex normals
  for (let i = 0; i < currentVertexCount; i++) {
    const idx = i * 3;
    const len = Math.hypot(vertexNormals[idx], vertexNormals[idx + 1], vertexNormals[idx + 2]);
    if (len > 1e-10) {
      vertexNormals[idx] /= len;
      vertexNormals[idx + 1] /= len;
      vertexNormals[idx + 2] /= len;
    }
  }
  
  // Step 4: Build edge collapse priority queue
  // Use a cost that combines: low degree (prefer), boundary avoidance, feature preservation
  const edgeCosts = new Map<string, number>();

  // Compute mesh features ONCE up front. Detecting features is O(triangles),
  // so calling it inside the per-edge loop made the whole pass O(triangles^2)
  // and froze the tool on real models. Hoisting it keeps the result identical
  // while making simplification dramatically faster.
  const features = detectMeshFeatures({ positions: currentPositions, indices: currentIndices });

  for (let i = 0; i < currentTriangleCount; i++) {
    const a = currentIndices[i * 3];
    const b = currentIndices[i * 3 + 1];
    const c = currentIndices[i * 3 + 2];
    
    // Process three edges per triangle
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      
      // Base cost: higher degree = higher cost (prefer collapsing low-degree vertices)
      const degreeCost = vertexDegree[u] + vertexDegree[v];
      
      // Boundary penalty
      const isBoundaryU = features.boundaryVertices.has(u);
      const isBoundaryV = features.boundaryVertices.has(v);
      
      let cost = degreeCost;
      if (isBoundaryU || isBoundaryV) {
        cost *= 5; // Heavy penalty for boundary edges
      }
      
      // Feature penalty
      const isFeatureU = features.featureVertices.has(u);
      const isFeatureV = features.featureVertices.has(v);
      if (isFeatureU || isFeatureV) {
        cost *= 2; // Moderate penalty for feature edges
      }
      
      // Keep minimum cost for each edge
      if (!edgeCosts.has(key) || cost < edgeCosts.get(key)!) {
        edgeCosts.set(key, cost);
      }
    }
  }
  
  // Step 5: Build max-heap (we want to pop highest cost first = safest to collapse)
  // Actually, let's use a min-heap on cost/degree ratio for best collapse order
  type Edge = { v1: number; v2: number; cost: number; degree: number; };
  const edges: Edge[] = [];
  
  for (const [key, cost] of edgeCosts) {
    const parts = key.split(':');
    const v1 = parseInt(parts[0]);
    const v2 = parseInt(parts[1]);
    const degree = vertexDegree[v1] + vertexDegree[v2];
    edges.push({ v1, v2, cost, degree });
  }
  
  // Sort by: cost/degree ratio ascending (cheapest collapses first)
  edges.sort((a, b) => {
    const ratioA = a.cost / Math.max(1, a.degree);
    const ratioB = b.cost / Math.max(1, b.degree);
    return ratioA - ratioB;
  });
  
  // Step 6: Iteratively collapse edges
  const alive = new Uint8Array(currentVertexCount);
  for (let i = 0; i < currentVertexCount; i++) alive[i] = 1;
  
  let trianglesRemoved = 0;
  let edgeIndex = 0;
  
  // Progress callback
  let progressLast = 0;
  
  while (trianglesRemoved < trianglesToRemove && edgeIndex < edges.length && trianglesRemoved < currentTriangleCount) {
    const edge = edges[edgeIndex];
    edgeIndex++;
    
    const { v1, v2 } = edge;
    
    // Skip if either vertex is no longer alive
    if (!alive[v1] || !alive[v2]) continue;
    
    // Skip if collapsing would create degenerate geometry
    // Count triangles that would be affected
    let affectedTriangles = 0;
    for (let i = 0; i < currentTriangleCount; i++) {
      const triV1 = currentIndices[i * 3] === v1 || currentIndices[i * 3 + 1] === v1 || currentIndices[i * 3 + 2] === v1;
      const triV2 = currentIndices[i * 3] === v2 || currentIndices[i * 3 + 1] === v2 || currentIndices[i * 3 + 2] === v2;
      if (triV1 || triV2) affectedTriangles++;
    }
    
    // Only collapse if it affects few triangles (efficient collapse)
    if (affectedTriangles < 50) {
      // Collapse v2 into v1
      alive[v2] = 0;
      
      // Update triangle indices - replace v2 with v1
      for (let i = 0; i < currentTriangleCount; i++) {
        for (let j = 0; j < 3; j++) {
          if (currentIndices[i * 3 + j] === v2) {
            currentIndices[i * 3 + j] = v1;
          }
        }
      }
      
      trianglesRemoved++;
    }
    
    // Progress update
    if (onProgress && trianglesRemoved > 0 && trianglesRemoved / trianglesToRemove > progressLast + 0.05) {
      progressLast = trianglesRemoved / trianglesToRemove;
      onProgress(0.1 + Math.min(0.8, progressLast * 0.7));
    }
  }
  
  // Final progress
  if (onProgress) {
    const progress = trianglesToRemove > 0 ? Math.min(0.95, 0.1 + 0.8 * trianglesRemoved / trianglesToRemove) : 0.1;
    onProgress(Math.min(progress, 1.0));
  }
  
  // Step 7: Compact the mesh
  const compactResult = compactMesh(currentPositions, currentIndices, cleaned.format);
  
  const processingTime = performance.now() - startTime;
  
  return {
    positions: compactResult.positions,
    indices: compactResult.indices,
    format: cleaned.format,
    bounds: compactResult.bounds,
    processingTime,
    originalTriangleCount: triangleCount,
    finalTriangleCount: compactResult.indices.length / 3
  };
}
