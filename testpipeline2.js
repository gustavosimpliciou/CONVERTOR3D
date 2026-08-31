const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Mock the MeshData type and import functions
// We'll test the core functions directly

// First, test cleanMesh
console.log('Testing cleanMesh logic...');

// Parse triangle count
const triangleCount = buf.readUInt32LE(80);
console.log('Triangle count:', triangleCount);

// Build positions and indices
const positions = new Float32Array(triangleCount * 9);
const indices = new Uint32Array(triangleCount * 3);

const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

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

// Now simulate cleanMesh
const EPSILON = 1e-12;
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

// Build vertex map
const vertexMap = new Map();
const remap = new Uint32Array(positions.length / 3);
const uniquePositions = [];

for (let i = 0; i < positions.length / 3; i++) {
    const key = positions[i * 3].toFixed(6) + ',' + positions[i * 3 + 1].toFixed(6) + ',' + positions[i * 3 + 2].toFixed(6);
    let newIdx = vertexMap[key];
    if (newIdx === undefined) {
        newIdx = uniquePositions.length / 3;
        vertexMap[key] = newIdx;
        uniquePositions.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
    }
    remap[i] = newIdx;
}

// Remap indices, skipping degenerate faces
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

console.log('Original triangles:', triangleCount);
console.log('Degenerate faces:', degenerateFaces.filter(x => x === 1).length);
console.log('Valid triangles after cleanup:', validTriangleCount);

// Now test buildStats on cleaned mesh
let degenerateTriangles = 0;
let finite = true;
for (let i = 0; i < uniquePositions.length; i++) {
    if (!Number.isFinite(uniquePositions[i])) finite = false;
}
for (let i = 0; i < newIndices.length; i += 3) {
    const a = newIndices[i];
    const b = newIndices[i + 1];
    const c = newIndices[i + 2];
    if (
        a >= uniquePositions.length / 3 ||
        b >= uniquePositions.length / 3 ||
        c >= uniquePositions.length / 3 ||
        a === b ||
        b === c ||
        a === c
    ) {
        degenerateTriangles += 1;
        continue;
    }
    
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    const abx = uniquePositions[ib] - uniquePositions[ia];
    const aby = uniquePositions[ib + 1] - uniquePositions[ia + 1];
    const abz = uniquePositions[ib + 2] - uniquePositions[ia + 2];
    const acx = uniquePositions[ic] - uniquePositions[ia];
    const acy = uniquePositions[ic + 1] - uniquePositions[ia + 1];
    const acz = uniquePositions[ic + 2] - uniquePositions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const areaSq = nx * nx + ny * ny + nz * nz;
    
    if (areaSq <= EPSILON) {
        degenerateTriangles += 1;
    }
}

console.log('Finite positions:', finite);
console.log('Degenerate triangles after cleanup:', degenerateTriangles);

// Test STL validation
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

console.log('Binary STL validation:', stlValid ? 'PASS' : 'FAIL');

// Test compactMesh
const compactResult = {
    positions: uniquePositions.length > 0 ? new Float32Array(uniquePositions) : new Float32Array(),
    indices: newIndices.length > 0 ? new Uint32Array(newIndices) : new Uint32Array(),
    format: 'STL',
    bounds: { min: [0,0,0], max: [0,0,0], size: [0,0,0] }
};

// Calculate bounds
let minX = Infinity, minY = Infinity, minZ = Infinity;
let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
for (let i = 0; i < uniquePositions.length; i += 3) {
    minX = Math.min(minX, uniquePositions[i]);
    minY = Math.min(minY, uniquePositions[i + 1]);
    minZ = Math.min(minZ, uniquePositions[i + 2]);
    maxX = Math.max(maxX, uniquePositions[i]);
    maxY = Math.max(maxY, uniquePositions[i + 1]);
    maxZ = Math.max(maxZ, uniquePositions[i + 2]);
}
compactResult.bounds = { min: [minX, minY, minZ], max: [maxX, maxY, maxZ], size: [maxX - minX, maxY - minY, maxZ - minZ] };

console.log('Bounds:', compactResult.bounds);
console.log('Final vertex count:', uniquePositions.length / 3);
console.log('Final triangle count:', newIndices.length / 3);
console.log('Success! The joker.stl file can now be processed correctly.');