const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Parse binary STL similar to the stl.ts exportBinaryStl function
const triangleCount = buf.readUInt32LE(80);
console.log('Triangle count:', triangleCount);

// Build MeshData like the pipeline would
const positions = new Float32Array(triangleCount * 3 * 3); // 3 vertices * 3 coords per triangle
const indices = new Uint32Array(triangleCount * 3);

const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

for (let i = 0; i < triangleCount; i++) {
    const offset = 84 + i * 50;
    
    // Normal vector (3 floats - we skip this, but it's at offset)
    
    // Vertex positions (3 vertices * 3 coords)
    for (let j = 0; j < 3; j++) {
        const vertexOffset = offset + 12 + j * 12;
        const idx = i * 3 * 3 + j * 3;
        
        positions[idx] = dv.getFloat32(vertexOffset, true);
        positions[idx + 1] = dv.getFloat32(vertexOffset + 4, true);
        positions[idx + 2] = dv.getFloat32(vertexOffset + 8, true);
        
        // Index - vertex index in the flat array
        // Actually in STL each triangle has its own 3 vertices, 
        // but for mesh simplification we need to track shared vertices
        // For now, just use the raw indices
        indices[i * 3 + j] = i; // Using triangle index as vertex index for simplicity
    }
}

// Now test validation
// Let me check triangle areas
let degenerate = 0;
let total = 0;

for (let i = 0; i < Math.min(triangleCount, 500); i++) {
    const a = i * 3;
    const b = i * 3 + 1;
    const c = i * 3 + 2;
    
    if (a >= positions.length / 3 || b >= positions.length / 3 || c >= positions.length / 3) {
        degenerate++;
        continue;
    }
    
    if (a === b || b === c || a === c) {
        degenerate++;
        continue;
    }
    
    total++;
    
    // Calculate area
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    const abx = bx - ax, aby = by - ay, abz = bz - az;
    const acx = cx - ax, acy = cy - ay, acz = cz - az;
    
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    
    const areaSq = nx * nx + ny * ny + nz * nz;
    
    if (areaSq <= 1e-24) {
        degenerate++;
    }
}

console.log('Total tris checked:', total);
console.log('Degenerate tris:', degenerate);
console.log('Ratio:', degenerate / total);

// Now test the buildStats function logic
let finite = true;
for (let i = 0; i < positions.length; i++) {
    if (!Number.isFinite(positions[i])) finite = false;
}
console.log('All positions finite:', finite);