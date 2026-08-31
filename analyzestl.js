const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
const triangleCount = dv.getUint32(80, true);
console.log('Triangle count:', triangleCount);

// Parse first few triangles to check normals and validity
let validTris = 0;
let invalidTris = 0;
let zeroAreaTris = 0;

for (let i = 0; i < Math.min(triangleCount, 100); i++) {
    const offset = 84 + i * 50;
    
    // Normal vector (3 floats)
    const nx = dv.getFloat32(offset, true);
    const ny = dv.getFloat32(offset + 4, true);
    const nz = dv.getFloat32(offset + 8, true);
    
    // Vertex positions (3 floats each)
    const v1x = dv.getFloat32(offset + 12, true);
    const v1y = dv.getFloat32(offset + 16, true);
    const v1z = dv.getFloat32(offset + 20, true);
    const v2x = dv.getFloat32(offset + 24, true);
    const v2y = dv.getFloat32(offset + 28, true);
    const v2z = dv.getFloat32(offset + 32, true);
    const v3x = dv.getFloat32(offset + 36, true);
    const v3y = dv.getFloat32(offset + 40, true);
    const v3z = dv.getFloat32(offset + 44, true);
    
    // Calculate area using cross product
    const abx = v2x - v1x;
    const aby = v2y - v1y;
    const abz = v2z - v1z;
    const acx = v3x - v1x;
    const acy = v3y - v1y;
    const acz = v3z - v1z;
    
    const nxCalc = aby * acz - abz * acy;
    const nyCalc = abz * acx - abx * acz;
    const nzCalc = abx * acy - aby * acx;
    
    const areaSq = nxCalc * nxCalc + nyCalc * nyCalc + nzCalc * nzCalc;
    const area = Math.sqrt(areaSq) * 0.5;
    
    // Check if normal matches geometric normal
    const normalLen = Math.sqrt(nx*nx + ny*ny + nz*nz);
    const dot = nx * nxCalc + ny * nyCalc + nz * nzCalc;
    const normalsMatch = normalLen > 0.001 && Math.abs(dot) / (normalLen * Math.sqrt(areaSq)) > 0.99;
    
    if (area < 1e-10) {
        zeroAreaTris++;
    }
    
    if (!normalsMatch) {
        invalidTris++;
        if (invalidTris <= 5) {
            console.log('Triangle ' + i + ': nx=' + nx.toFixed(4) + ' ny=' + ny.toFixed(4) + ' nz=' + nz.toFixed(4) + ', area=' + area.toExponential() + ', matches=' + normalsMatch);
        }
    } else {
        validTris++;
    }
}

console.log('Valid tris (first 100):', validTris);
console.log('Invalid tris (first 100):', invalidTris);
console.log('Zero area tris (first 100):', zeroAreaTris);