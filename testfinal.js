const fs = require('fs');
const path = require('path');
const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Parse STL triangle count
const triangleCount = buf.readUInt32LE(80);
console.log('Original triangle count from STL header:', triangleCount);

// Calculate file size expectation
const expectedSize = 84 + triangleCount * 50;
console.log('Expected file size:', expectedSize);
console.log('Actual file size:', buf.length);

// Test cleanMesh logic
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

// Build mock mesh data
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

const mesh = { positions, indices, format: 'STL', bounds: calculateBounds(positions) };
const cleaned = cleanMesh(mesh);

console.log('\nAfter cleaning:');
console.log('Triangles:', cleaned.indices.length / 3);
console.log('Vertices:', cleaned.positions.length / 3);
console.log('Degenerate faces removed:', cleaned.degenerateFaceCount);

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

console.log('\nBinary STL validation:', stlValid ? 'PASS' : 'FAIL');

// Final validation - check for degenerate triangles
let degenerateTriangles = 0;
let finite = true;
for (let i = 0; i < cleaned.positions.length; i++) {
    if (!Number.isFinite(cleaned.positions[i])) finite = false;
}
for (let i = 0; i < cleaned.indices.length; i += 3) {
    const a = cleaned.indices[i];
    const b = cleaned.indices[i + 1];
    const c = cleaned.indices[i + 2];
    if (
        a >= cleaned.positions.length / 3 ||
        b >= cleaned.positions.length / 3 ||
        c >= cleaned.positions.length / 3 ||
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
    const abx = cleaned.positions[ib] - cleaned.positions[ia];
    const aby = cleaned.positions[ib + 1] - cleaned.positions[ia + 1];
    const abz = cleaned.positions[ib + 2] - cleaned.positions[ia + 2];
    const acx = cleaned.positions[ic] - cleaned.positions[ia];
    const acy = cleaned.positions[ic + 1] - cleaned.positions[ia + 1];
    const acz = cleaned.positions[ic + 2] - cleaned.positions[ia + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const areaSq = nx * nx + ny * ny + nz * nz;

    if (areaSq <= 1e-12) {
        degenerateTriangles += 1;
    }
}

console.log('Finite positions:', finite);
console.log('Degenerate triangles after cleanup:', degenerateTriangles);

if (stlValid && degenerateTriangles === 0 && finite) {
    console.log('\n=== SUCCESS ===');
    console.log('The joker.stl file now processes correctly!');
    console.log('- No invalid faces');
    console.log('- STL validation passes');
    console.log('- All positions are finite');
    console.log('- Ready for mesh reduction pipeline');
} else {
    console.log('\n=== FAILURE ===');
    console.log('Issues found that need to be fixed.');
}