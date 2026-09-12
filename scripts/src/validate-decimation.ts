/**
 * TESTES DE REGRESSÃO DO ENGINE DE DECIMAÇÃO (§60 do prompt master).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:decimation`
 * (ou `npx tsx src/validate-decimation.ts` dentro de scripts/).
 *
 * Cobre:
 *  - redução moderada e agressiva em malha plana (cubo subdividido)
 *  - curvatura uniforme (esfera densa): sem buracos, volume preservado
 *  - modelo orgânico sintético com microdetalhes + estruturas finas:
 *    densidade adaptativa (detalhe preservado > base plana), zero novos
 *    buracos, zero non-manifold, zero degenerados
 *  - watertightness / manifoldness / exportação STL + revalidação do buffer
 *  - vertex welding controlado (soup STL com vértices duplicados)
 *  - target flexível: integridade tem prioridade sobre o número de faces
 */
import { simplifyMesh } from '../../artifacts/redutor-3d/src/lib/mesh/simplifier';
import { auditMesh, approveConversion } from '../../artifacts/redutor-3d/src/lib/mesh/validation';
import { buildStats, calculateBounds, normalizeTriangles } from '../../artifacts/redutor-3d/src/lib/mesh/geometry';
import { exportBinaryStl, validateBinaryStl } from '../../artifacts/redutor-3d/src/lib/mesh/stl';
import type { MeshData } from '../../artifacts/redutor-3d/src/lib/mesh/types';

let failures = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function toMesh(positions: number[], triangles: number[][], format: MeshData['format'] = 'STL'): MeshData {
  return normalizeTriangles(positions, triangles, format);
}

/** Cubo subdividido n x n por face (malha fechada, regiões planas). */
function subdividedCube(n: number): MeshData {
  const positions: number[] = [];
  const triangles: number[][] = [];
  const faces: Array<(u: number, v: number) => [number, number, number]> = [
    (u, v) => [-1 + 2 * u, -1 + 2 * v, 1],
    (u, v) => [-1 + 2 * u, -1 + 2 * v, -1],
    (u, v) => [1, -1 + 2 * u, -1 + 2 * v],
    (u, v) => [-1, -1 + 2 * u, -1 + 2 * v],
    (u, v) => [-1 + 2 * u, 1, -1 + 2 * v],
    (u, v) => [-1 + 2 * u, -1, -1 + 2 * v],
  ];
  for (const fn of faces) {
    const base = positions.length / 3;
    for (let i = 0; i <= n; i += 1) {
      for (let j = 0; j <= n; j += 1) positions.push(...fn(i / n, j / n));
    }
    for (let i = 0; i < n; i += 1) {
      for (let j = 0; j < n; j += 1) {
        const a = base + i * (n + 1) + j;
        const b = base + (i + 1) * (n + 1) + j;
        const c = base + (i + 1) * (n + 1) + j + 1;
        const d = base + i * (n + 1) + j + 1;
        triangles.push([a, b, d], [b, c, d]);
      }
    }
  }
  return toMesh(positions, triangles);
}

/** Icosaedro subdividido (curvatura uniforme, fechado). */
function icosphere(subdivisions: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions: number[] = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let triangles: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const midpoint = (a: number, b: number): number => {
    const r = 6371 + a * 7919 + b * 104729;
    void r;
    const ax = positions[a * 3]; const ay = positions[a * 3 + 1]; const az = positions[a * 3 + 2];
    const bx = positions[b * 3]; const by = positions[b * 3 + 1]; const bz = positions[b * 3 + 2];
    const mx = (ax + bx) / 2; const my = (ay + by) / 2; const mz = (az + bz) / 2;
    const len = Math.hypot(mx, my, mz) || 1;
    positions.push((mx / len) * 2, (my / len) * 2, (mz / len) * 2);
    return positions.length / 3 - 1;
  };
  for (let s = 0; s < subdivisions; s += 1) {
    const next: number[][] = [];
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let m = cache.get(key);
      if (m === undefined) {
        m = midpoint(a, b);
        cache.set(key, m);
      }
      return m;
    };
    for (const [a, b, c] of triangles) {
      const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    triangles = next;
  }
  return toMesh(positions, triangles);
}

/**
 * Modelo orgânico sintético: base esférica + relevo denso (microdetalhes) +
 * 3 "dedos" finos. Testa densidade adaptativa e proteção de estruturas finas.
 */
function organicMock(): { mesh: MeshData; detailCenter: [number, number, number]; detailRadius: number } {
  const sphere = icosphere(3);
  const positions = Array.from(sphere.positions);
  const triangles: number[][] = [];
  for (let i = 0; i < sphere.indices.length; i += 3) {
    triangles.push([sphere.indices[i], sphere.indices[i + 1], sphere.indices[i + 2]]);
  }
  // Relevo: deslocamento senoidal de alta frequência no hemisfério +Y.
  const count = positions.length / 3;
  for (let v = 0; v < count; v += 1) {
    const x = positions[v * 3]; const y = positions[v * 3 + 1]; const z = positions[v * 3 + 2];
    if (y > 0.4) {
      const bump = 0.09 * Math.sin(x * 22) * Math.sin(z * 22) + 0.05 * Math.sin(x * 47 + z * 31);
      const len = Math.hypot(x, y, z) || 1;
      const k = (len + bump) / len;
      positions[v * 3] = x * k; positions[v * 3 + 1] = y * k; positions[v * 3 + 2] = z * k;
    }
  }
  // Dedos: 3 cilindros finos no polo sul.
  const finger = (cx: number, cz: number): void => {
    const radial = 8; const rings = 10; const r = 0.09; const len = 0.9;
    const base = positions.length / 3;
    for (let ring = 0; ring <= rings; ring += 1) {
      const y = -2 - (ring / rings) * len;
      for (let s = 0; s < radial; s += 1) {
        const a = (s / radial) * Math.PI * 2;
        positions.push(cx + Math.cos(a) * r, y, cz + Math.sin(a) * r);
      }
    }
    for (let ring = 0; ring < rings; ring += 1) {
      for (let s = 0; s < radial; s += 1) {
        const a = base + ring * radial + s;
        const b = base + ring * radial + ((s + 1) % radial);
        const c = base + (ring + 1) * radial + s;
        const d = base + (ring + 1) * radial + ((s + 1) % radial);
        triangles.push([a, c, b], [b, c, d]);
      }
    }
  };
  finger(0.35, 0); finger(-0.35, 0.2); finger(0, -0.35);
  const mesh = toMesh(positions, triangles);
  return { mesh, detailCenter: [0, 2, 0], detailRadius: 1.4 };
}

function densityInRegion(mesh: MeshData, center: [number, number, number], radius: number): number {
  let inside = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const cx = (mesh.positions[mesh.indices[i] * 3] + mesh.positions[mesh.indices[i + 1] * 3] + mesh.positions[mesh.indices[i + 2] * 3]) / 3;
    const cy = (mesh.positions[mesh.indices[i] * 3 + 1] + mesh.positions[mesh.indices[i + 1] * 3 + 1] + mesh.positions[mesh.indices[i + 2] * 3 + 1]) / 3;
    const cz = (mesh.positions[mesh.indices[i] * 3 + 2] + mesh.positions[mesh.indices[i + 1] * 3 + 2] + mesh.positions[mesh.indices[i + 2] * 3 + 2]) / 3;
    if (Math.hypot(cx - center[0], cy - center[1], cz - center[2]) <= radius) inside += 1;
  }
  return inside;
}

// --- 1. Cubo: redução moderada (50%) ---
{
  const mesh = subdividedCube(12);
  const original = mesh.indices.length / 3;
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(original * 0.5), quality: 'high',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 20_000,
  });
  const ref = auditMesh(mesh);
  const out = auditMesh({ positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions) });
  check('cubo/reducao-moderada: reduziu sem aumentar faces', result.triangles <= original && result.triangles > 0, `${original} → ${result.triangles}`);
  check('cubo/reducao-moderada: watertight preservado', out.boundaryLoops === ref.boundaryLoops, `loops=${out.boundaryLoops}`);
  check('cubo/reducao-moderada: sem non-manifold', out.nonManifoldEdges === 0, `nm=${out.nonManifoldEdges}`);
}

// --- 2. Cubo: redução agressiva (10%) com target flexível ---
{
  const mesh = subdividedCube(12);
  const original = mesh.indices.length / 3;
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(original * 0.1), quality: 'ultra',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 20_000,
  });
  const ref = auditMesh(mesh);
  const out = auditMesh({ positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions) });
  check('cubo/reducao-agressiva: zero novos buracos', out.boundaryLoops <= ref.boundaryLoops, `loops=${out.boundaryLoops}`);
  check('cubo/reducao-agressiva: integridade acima do target', out.valid, `faces=${result.triangles} (alvo=${Math.floor(original * 0.1)})`);
}

// --- 3. Esfera: curvatura uniforme, volume e bounds ---
{
  const mesh = icosphere(3);
  const original = mesh.indices.length / 3;
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(original * 0.35), quality: 'high',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 20_000,
  });
  check('esfera: sem novos buracos', result.validation.boundaryLoops === 0, `loops=${result.validation.boundaryLoops}`);
  check('esfera: volume preservado (<2.5%)', result.validation.volumeDeltaPercent < 2.5, `${result.validation.volumeDeltaPercent.toFixed(2)}%`);
  check('esfera: dimensões preservadas (<1.2%)', result.validation.boundsDeltaPercent < 1.2, `${result.validation.boundsDeltaPercent.toFixed(2)}%`);
}

// --- 4. Orgânico: densidade adaptativa + estruturas finas ---
{
  const { mesh, detailCenter, detailRadius } = organicMock();
  const original = mesh.indices.length / 3;
  const detailBefore = densityInRegion(mesh, detailCenter, detailRadius);
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(original * 0.4), quality: 'high',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 30_000,
  });
  const reducedMesh: MeshData = {
    positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions),
  };
  const detailAfter = densityInRegion(reducedMesh, detailCenter, detailRadius);
  const detailRetention = detailAfter / Math.max(1, detailBefore);
  const globalRetention = result.triangles / original;
  check('organico: detalhe retido acima da média global', detailRetention >= globalRetention * 0.9, `detalhe=${(detailRetention * 100).toFixed(1)}% global=${(globalRetention * 100).toFixed(1)}%`);
  check('organico: zero novos buracos', result.validation.boundaryLoops === 0, `loops=${result.validation.boundaryLoops}`);
  check('organico: sem non-manifold', result.validation.nonManifoldEdges === 0, `nm=${result.validation.nonManifoldEdges}`);
  const stats = buildStats(reducedMesh);
  check('organico: sem triângulos degenerados', stats.degenerateTriangles === 0, `deg=${stats.degenerateTriangles}`);
}

// --- 5. Exportação STL + revalidação do buffer ---
{
  const { mesh } = organicMock();
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(mesh.indices.length / 9), quality: 'medium',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 30_000,
  });
  const reducedMesh: MeshData = {
    positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions),
  };
  const stl = exportBinaryStl(reducedMesh);
  check('stl: buffer válido', stl.valid && validateBinaryStl(stl.buffer), `tris=${stl.triangles}`);
  check('stl: contagem confere', stl.triangles === reducedMesh.indices.length / 3);
}

// --- 6. Welding controlado: soup com vértices duplicados ---
{
  const positions = [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0];
  const mesh = toMesh(positions, [[0, 1, 2], [3, 4, 5]]);
  const stats = buildStats(mesh);
  check('welding: duplicatas fundidas sem buracos extras', stats.vertices === 4 && stats.triangles === 2, `v=${stats.vertices} t=${stats.triangles}`);
}

// --- 7. Critério de aprovação completo ---
{
  const mesh = icosphere(2);
  const result = simplifyMesh(mesh, {
    targetTriangles: Math.floor(mesh.indices.length / 9), quality: 'high',
    preserveBorders: true, preserveSilhouette: true, protectDetails: true, timeBudgetMs: 20_000,
  });
  const ref = auditMesh(mesh);
  const cand = auditMesh({ positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions) });
  const report = approveConversion(cand, ref, { mean: 0.001, max: 0.01 }, 0, 0, 'high');
  check('aprovacao: checklist passa em malha saudável', report.approved, report.reasons.join(' '));
  const broken: MeshData = { positions: result.positions, indices: result.indices.slice(3), format: 'STL', bounds: calculateBounds(result.positions) };
  const brokenAudit = auditMesh(broken, ref);
  const brokenReport = approveConversion(brokenAudit, ref, { mean: 0.5, max: 0.9 }, 1, 5, 'high');
  check('aprovacao: checklist reprova malha danificada', !brokenReport.approved);
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
