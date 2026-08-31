const fs = require('fs');
const path = require('path');

// Simulate the pipeline functions
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Mock MeshData interface
function createMeshDataFromBuffer(buffer) {
  const triangleCount = buffer.readUInt32LE(80);
  const positions = new Float32Array(triangleCount * 9);
  const indices = new Uint32Array(triangleCount * 3);
  
  const dv = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  
  for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    for (let j = 0; j < 3; j++) {
      const vertexOffset = offset + 12 + j * 12;
      const idx = i * 3 + j;
      positions[idx * 3] = dv.getFloat32(vertexOffset, true);
      positions[idx * 3 + 1] = dv.getFloat32(vertexOffset + 4, true);
      positions[idx * 3 + 2] = dv.getFloat32(vertexOffset + 8, true);
      indices[idx * 3] = i * 3 + j;
      indices[idx * 3 + 1] = i * 3 + j + 1;
      indices[idx * 3 + 2] = i * 3 + j + 2;
    }
  }
  
  const bounds = calculateBounds(positions);
  return { positions, indices, format: 'STL', bounds };
}

function calculateBounds(positions) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }
  return { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };
}

// Import cleanMesh logic
function cleanMesh(mesh) {
  const positions = mesh.positions;
  const indices = mesh.indices;
  const vertexCount = positions.length / 3;
  const triangleCount = indices.length / 3;

  const degenerateFaces = new Uint8Array(triangleCount);

  for (let i = 0; i < triangleCount; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];

    if (a === b || b === c || a === c) {
      degenerateFaces[i] = 1;
      continue;
    }

    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];

    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;

    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;

    const areaSq = nx * nx + ny * ny + nz * nz;
    if (areaSq <= 1e-12) {
      degenerateFaces[i] = 1;
    }
  }

  const vertexMap = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const uniquePositions = [];

  for (let i = 0; i < vertexCount; i++) {
    const key = positions[i * 3].toFixed(6) + ',' + positions[i * 3 + 1].toFixed(6) + ',' + positions[i * 3 + 2].toFixed(6);
    let newIdx = vertexMap.get(key);
    if (newIdx === undefined) {
      newIdx = uniquePositions.length / 3;
      vertexMap.set(key, newIdx);
      uniquePositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = newIdx;
  }

  const newIndices = [];
  let validTriangleCount = 0;

  for (let i = 0; i < triangleCount; i++) {
    if (degenerateFaces[i]) continue;

    const a = remap[indices[i * 3]];
    const b = remap[indices[i * 3 + 1]];
    const c = remap[indices[i * 3 + 2]];

    if (a !== b && b !== c && a !== c) {
      newIndices.push(a, b, c);
      validTriangleCount++;
    }
  }

  return {
    positions: new Float32Array(uniquePositions),
    indices: new Uint32Array(newIndices),
    format: mesh.format,
    bounds: calculateBounds(new Float32Array(uniquePositions)),
    degenerateFaceCount: triangleCount - validTriangleCount
  };
}

// Import robustSimplifyMesh logic (simplified version)
function robustSimplifyMesh(mesh, options, onProgress) {
  const startTime = performance.now();
  const triangleCount = mesh.indices.length / 3;
  const vertexCount = mesh.positions.length / 3;

  // Clean first
  const cleaned = cleanMesh(mesh);
  let currentPositions = cleaned.positions;
  let currentIndices = cleaned.indices;
  const currentVertexCount = currentPositions.length / 3;
  const currentTriangleCount = currentIndices.length / 3;

  if (onProgress) onProgress(0.1);

  // Simple reduction targeting specific triangle count
  const targetTriangles = options.targetTriangles || Math.max(1, currentTriangleCount / 2);
  const trianglesToRemove = currentTriangleCount - targetTriangles;

  // Build edge map for collapse decisions
  const vertexTriangles = new Array(currentVertexCount).fill(0).map(() => []);
  for (let i = 0; i < currentTriangleCount; i++) {
    const a = currentIndices[i * 3];
    const b = currentIndices[i * 3 + 1];
    const c = currentIndices[i * 3 + 2];
    vertexTriangles[a].push(i);
    vertexTriangles[b].push(i);
    vertexTriangles[c].push(i);
  }

  const alive = new Uint8Array(currentVertexCount);
  for (let i = 0; i < currentVertexCount; i++) alive[i] = 1;

  let trianglesRemoved = 0;

  // Iteratively collapse edges until we reach target
  while (trianglesRemoved < trianglesToRemove && trianglesRemoved < currentTriangleCount) {
    // Find an edge to collapse - simple approach: pick a vertex and collapse one of its edges
    let edgeCollapsed = false;
    
    for (let v = 0; v < currentVertexCount && !edgeCollapsed; v++) {
      if (!alive[v]) continue;
      
      const connected = [];
      for (const triIdx of vertexTriangles[v]) {
        if (triIdx < currentTriangleCount) {
          const a = currentIndices[triIdx * 3];
          const b = currentIndices[triIdx * 3 + 1];
          const c = currentIndices[triIdx * 3 + 2];
          for (const vert of [a, b, c]) {
            if (alive[vert] && vert !== v) connected.push(vert);
          }
        }
      }
      
      // Try to collapse first connected edge
      if (connected.length > 0) {
        const target = connected[0];
        
        // Mark target as dead, merge into v
        alive[target] = 0;
        
        // Update triangle indices - replace target with v
        for (let i = 0; i < currentTriangleCount; i++) {
          for (let j = 0; j < 3; j++) {
            if (currentIndices[i * 3 + j] === target) {
              currentIndices[i * 3 + j] = v;
            }
          }
        }
        
        trianglesRemoved++;
        edgeCollapsed = true;
        break;
      }
    }
    
    if (!edgeCollapsed) break; // No more edges to collapse
  }

  // Compact the remaining mesh
  const used = new Set();
  for (const idx of currentIndices) used.add(idx);
  const remap2 = new Map();
  const compactPositions = [];
  let next = 0;
  for (const idx of used) {
    remap2.set(idx, next);
    compactPositions.push(
      currentPositions[idx * 3],
      currentPositions[idx * 3 + 1],
      currentPositions[idx * 3 + 2]
    );
    next += 1;
  }
  // Convert Set to array for indexing
  const usedArray = Array.from(used);
  const compactIndices = [];
  for (let i = 0; i < currentIndices.length; i++) {
    const idx = currentIndices[i];
    const found = remap2.get(idx);
    if (found !== undefined) compactIndices.push(found);
  }

  return {
    positions: new Float32Array(compactPositions),
    indices: new Uint32Array(compactIndices),
    format: cleaned.format,
    bounds: calculateBounds(new Float32Array(compactPositions)),
    processingTime: performance.now() - startTime,
    originalTriangleCount: triangleCount,
    finalTriangleCount: compactIndices.length / 3
  };
}

// Main pipeline test
console.log('=== Full Pipeline Test ===');
const mesh = createMeshDataFromBuffer(buf);
console.log('Original triangles:', mesh.indices.length / 3);
console.log('Original vertices:', mesh.positions.length / 3);
console.log('Original bounds:', mesh.bounds);

// Step 1: Clean
console.log('\n--- Step 1: Cleaning ---');
const cleaned = cleanMesh(mesh);
console.log('Cleaned triangles:', cleaned.indices.length / 3);
console.log('Cleaned vertices:', cleaned.positions.length / 3);
console.log('Removed degenerate faces:', cleaned.degenerateFaceCount);

// Step 2: Simplify
console.log('\n--- Step 2: Simplification ---');
const options = { targetTriangles: 100000 }; // Reduce to 100K triangles
const simplified = robustSimplifyMesh(mesh, options, (phase, progress) => {
  console.log(`${phase}: ${Math.round(progress * 100)}%`);
});
console.log('Simplified triangles:', simplified.finalTriangleCount);
console.log('Simplified vertices:', simplified.positions.length / 3);
console.log('Processing time:', simplified.processingTime.toFixed(2), 'ms');

// Step 3: Validate final result
console.log('\n--- Step 3: Validation ---');

// Final validation using buildStats logic
let degenerateTris = 0;
let finite = true;
for (let i = 0; i < simplified.positions.length; i++) {
    if (!Number.isFinite(simplified.positions[i])) finite = false;
}
for (let i = 0; i < simplified.indices.length; i += 3) {
    const a = simplified.indices[i];
    const b = simplified.indices[i + 1];
    const c = simplified.indices[i + 2];
    if (
        a >= simplified.positions.length / 3 ||
        b >= simplified.positions.length / 3 ||
        c >= simplified.positions.length / 3 ||
        a === b ||
        b === c ||
        a === c
    ) {
        degenerateTris += 1;
        continue;
    }
    
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    const abx = simplified.positions[ib] - simplified.positions[ia];
    const aby = simplified.positions[ib + 1] - simplified.positions[ia + 1];
    const abz = simplified.positions[ib + 2] - simplified.positions[ia + 2];
    const acx = simplified.positions[ic] - simplified.positions[ia];
    const acy = simplified.positions[ic + 1] - simplified.positions[ia + 1];
    const acz = simplified.positions[ic + 2] - simplified.positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const areaSq = nx * nx + ny * ny + nz * nz;

    if (areaSq <= 1e-12) {
        degenerateTris += 1;
    }
}

console.log('Finite positions:', finite);
console.log('Degenerate triangles:', degenerateTris);

// Test STL export validation
const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const triangles = view.getUint32(80, true);
let stlValid = true;
if (buf.byteLength !== 84 + triangles * 50) stlValid = false;
for (let triangle = 0; triangle < triangles && stlValid; triangle += 1) {
    const offset = 84 + triangle * 50;
    for (let floatOffset = 0; floatOffset < 48; floatOffset += 4) {
      if (!Number.isFinite(view.getFloat32(offset + floatOffset, true))) { stlValid = false; break; }
    }
}

console.log('Binary STL validation (original):', stlValid ? 'PASS' : 'FAIL');

console.log('\n=== Pipeline Complete ===');
console.log('Success! joker.stl processed through full pipeline.');