import { simplifyMesh } from '../src/lib/mesh/simplifier';
import type { MeshData } from '../src/lib/mesh/types';

// Build a UV sphere mesh to exercise the simplifier end-to-end.
function makeSphere(segments: number, rings: number): MeshData {
  const positions: number[] = [];
  const indices: number[] = [];

  for (let y = 0; y <= rings; y++) {
    const v = y / rings;
    const phi = v * Math.PI;
    for (let x = 0; x <= segments; x++) {
      const u = x / segments;
      const theta = u * Math.PI * 2;
      positions.push(
        Math.sin(phi) * Math.cos(theta),
        Math.cos(phi),
        Math.sin(phi) * Math.sin(theta),
      );
    }
  }

  const stride = segments + 1;
  for (let y = 0; y < rings; y++) {
    for (let x = 0; x < segments; x++) {
      const a = y * stride + x;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      indices.push(a, c, b);
      indices.push(b, c, d);
    }
  }

  return {
    positions: new Float32Array(positions),
    indices: new Uint32Array(indices),
    format: 'stl',
  } as unknown as MeshData;
}

function testAt(ratio: number) {
  const mesh = makeSphere(80, 80);
  const originalTris = mesh.indices.length / 3;
  const target = Math.floor(originalTris * ratio);

  const t0 = performance.now();
  const result = simplifyMesh(
    mesh,
    { targetTriangles: target, quality: 'high', preserveBorders: true, preserveSilhouette: true, protectDetails: true } as any,
    () => {},
  );
  const elapsed = performance.now() - t0;

  const finalTris = result.indices.length / 3;
  const maxIndex = result.indices.reduce((m: number, v: number) => Math.max(m, v), 0);
  const vertCount = result.positions.length / 3;
  const indicesInRange = maxIndex < vertCount;
  const noNaN = !Array.from(result.positions as Float32Array).some((n) => Number.isNaN(n));
  const closeToTarget = finalTris <= target * 1.1;

  console.log(
    `[v0] target ${(ratio * 100).toFixed(0)}%: orig=${originalTris} target=${target} final=${finalTris} ` +
    `reduction=${(100 - (finalTris / originalTris) * 100).toFixed(1)}% time=${elapsed.toFixed(0)}ms ` +
    `inRange=${indicesInRange} noNaN=${noNaN} hitTarget=${closeToTarget}`,
  );

  return indicesInRange && noNaN && finalTris > 0 && finalTris < originalTris;
}

function run() {
  console.log('[v0] Testing real simplifyMesh (QEM) used by the worker');
  const r1 = testAt(0.5);
  const r2 = testAt(0.25);
  const r3 = testAt(0.1);
  if (r1 && r2 && r3) {
    console.log('[v0] RESULT: PASS');
    process.exit(0);
  } else {
    console.log('[v0] RESULT: FAIL');
    process.exit(1);
  }
}

run();
