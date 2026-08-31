const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Parse binary STL
const triangleCount = buf.readUInt32LE(80);
console.log('Triangle count:', triangleCount);

// Build MeshData
const positions = new Float32Array(triangleCount * 9); // 3 vertices * 3 coords, packed
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
        indices[idx * 3 + 1] = i * 3 + j + 1; // Actually these are the same in raw STL
        indices[idx * 3 + 2] = i * 3 + j + 2;
    }
}

// Now run the validation logic from mesh-validation.ts
const EPSILON = 1e-12;
let degenerateTriangles = 0;
let finite = true;
for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) finite = false;
}
for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    if (
        a >= positions.length / 3 ||
        b >= positions.length / 3 ||
        c >= positions.length / 3 ||
        a === b ||
        b === c ||
        a === c
    ) {
        degenerateTriangles += 1;
        continue;
    }
    
    // Calculate triangle area squared
    const ia = a * 3;
    const ib = b * 3;
    const ic = c * 3;
    const abx = positions[ib] - positions[ia];
    const aby = positions[ib + 1] - positions[ia + 1];
    const abz = positions[ib + 2] - positions[ia + 2];
    const acx = positions[ic] - positions[ia];
    const acy = positions[ic + 1] - positions[ia + 1];
    const acz = positions[ic + 2] - positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const areaSq = nx * nx + ny * ny + nz * nz;
    
    if (areaSq <= EPSILON) {
        degenerateTriangles += 1;
    }
}

console.log('Positions finite:', finite);
console.log('Total triangles:', indices.length / 3);
console.log('Degenerate triangles:', degenerateTriangles);

// Now test cleanMesh logic
const vertexCount = positions.length / 3;
const vertexMap = new Map();
const remap = new Uint32Array(positions.length / 3);
const uniquePositions = [];

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

const newIndices = [];
const triangleCount2 = indices.length / 3;
for (let i = 0; i < triangleCount2; i++) {
    const a = remap[indices[i * 3]];
    const b = remap[indices[i * 3 + 1]];
    const c = remap[indices[i * 3 + 2]];
    
    if (a !== b && b !== c && a !== c) {
        newIndices.push(a, b, c);
    }
}

console.log('After cleanMesh:');
console.log('Original triangles:', triangleCount2);
console.log('New indices length:', newIndices.length);
console.log('New triangles:', newIndices.length / 3);