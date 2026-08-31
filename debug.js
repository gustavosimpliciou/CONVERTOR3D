const fs = require('fs');
const path = require('path');

const filePath = path.join('C:', path.sep, 'Users', 'User', 'Documents', 'Nativos 3D', 'Site Modelos stl', 'CONVERTOR3D', 'joker.stl');
const buf = fs.readFileSync(filePath);

// Parse STL
const triangleCount = buf.readUInt32LE(80);
console.log('Triangle count:', triangleCount);

// Build mesh data
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

// Simulate cleanMesh
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

const mesh = { positions, indices, format: 'STL', bounds: calculateBounds(positions) };
const cleaned = cleanMesh(mesh);

let currentPositions = cleaned.positions;
let currentIndices = cleaned.indices;
const currentVertexCount = cleaned.positions.length / 3;
const currentTriangleCount = cleaned.indices.length / 3;

console.log('Cleaned triangles:', currentTriangleCount);
console.log('Cleaned vertices:', currentVertexCount);

// Compute edge costs
const edgeCosts = new Map();
const vertexDegree = new Float32Array(currentVertexCount);

for (let i = 0; i < currentTriangleCount; i++) {
    const a = currentIndices[i * 3];
    const b = currentIndices[i * 3 + 1];
    const c = currentIndices[i * 3 + 2];
    vertexDegree[a] += 1;
    vertexDegree[b] += 1;
    vertexDegree[c] += 1;
}

for (let i = 0; i < currentTriangleCount; i++) {
    const a = currentIndices[i * 3];
    const b = currentIndices[i * 3 + 1];
    const c = currentIndices[i * 3 + 2];

    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = u < v ? `${u}:${v}` : `${v}:${u}`;
        const degreeFactor = 1.0 / Math.max(1, vertexDegree[u] + vertexDegree[v]);
        
        let cost = degreeFactor;
        // No features computed in this simplified test, so skip boundary/feature penalties
        
        if (!edgeCosts.has(key) || cost < edgeCosts.get(key)) {
            edgeCosts.set(key, cost);
        }
    }
}

console.log('Edge costs computed:', edgeCosts.size);

// Build heap
class MinHeap {
    data = [];
    push(v1, v2, cost) {
        this.data.push({ v1: v1, v2: v2, cost: cost });
        let i = this.data.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent].cost <= cost) break;
            this.data[i] = this.data[parent];
            i = parent;
        }
        this.data[i] = { v1: v1, v2: v2, cost: cost };
    }
    pop() {
        if (!this.data.length) return undefined;
        const first = this.data[0];
        const last = this.data.pop();
        if (this.data.length) {
            let i = 0;
            while (true) {
                const left = i * 2 + 1;
                if (left >= this.data.length) break;
                const right = left + 1;
                let child;
                if (right >= this.data.length) child = left;
                else if (this.data[right].cost < this.data[left].cost) child = right;
                else child = left;
                if (this.data[child].cost >= last.cost) break;
                this.data[i] = this.data[child];
                i = child;
            }
            this.data[i] = last;
        }
        return first;
    }
    get size() { return this.data.length; }
}

const heap = new MinHeap();
for (const [key, cost] of edgeCosts) {
    const parts = key.split(':');
    heap.push(parseInt(parts[0]), parseInt(parts[1]), cost);
}

console.log('Heap size:', heap.size);

// Simplify
const targetTriangles = 100000;
const trianglesToRemove = currentTriangleCount - targetTriangles;
console.log('Triangles to remove:', trianglesToRemove);

// Iteratively collapse edges
const alive = new Uint8Array(currentVertexCount);
for (let i = 0; i < currentVertexCount; i++) alive[i] = 1;

let trianglesRemoved = 0;

for (let step = 0; step < 100; step++) {  // Limit iterations
    if (trianglesRemoved >= trianglesToRemove || heap.size === 0) break;
    
    const edge = heap.pop();
    if (!edge) break;
    
    const { v1, v2 } = edge;
    
    if (alive[v1] === 0 || alive[v2] === 0) continue;
    
    const key = v1 < v2 ? `${v1}:${v2}` : `${v2}:${v1}`;
    if (!edgeCosts.has(key)) continue;
    
    // Collapse v2 into v1
    alive[v2] = 0;
    
    // Update triangle indices
    for (let i = 0; i < currentTriangleCount; i++) {
        for (let j = 0; j < 3; j++) {
            if (currentIndices[i * 3 + j] === v2) {
                currentIndices[i * 3 + j] = v1;
            }
        }
    }
    
    trianglesRemoved++;
    console.log(`Step ${step}: removed ${trianglesRemoved}/${trianglesToRemove}`);
    
    // Progress check
    if (trianglesRemoved > 0 && trianglesRemoved % 50000 === 0) {
        if (trianglesToRemove > 0) {
            const progress = 0.1 + Math.min(0.8, trianglesRemoved / trianglesToRemove * 0.7);
            console.log(`Progress: ${progress} (${trianglesRemoved}/${trianglesToRemove})`);
        }
    }
}

console.log('Final: removed', trianglesRemoved, 'of', trianglesToRemove);