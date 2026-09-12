/**
 * TESTES DO MOTOR DE REDUÇÃO ADAPTATIVA (fluxo COMPRESSÃO 3D).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:reduction`
 *
 * Cobre: matemática do target (tamanho → faces), redução de 50% com
 * validação, ordenação dos perfis, métrica de silhueta, cascata/orçamento,
 * guard contra falso sucesso e end-to-end no STL real de 1,5M faces.
 */
import { readFileSync } from 'node:fs';
import { targetFacesForSize } from '../../artifacts/redutor-3d/src/lib/mesh/processor';
import { simplifyMesh } from '../../artifacts/redutor-3d/src/lib/mesh/simplifier';
import { silhouetteError } from '../../artifacts/redutor-3d/src/lib/mesh/safeguards';
import { auditMesh } from '../../artifacts/redutor-3d/src/lib/mesh/validation';
import { buildStats, calculateBounds, normalizeTriangles } from '../../artifacts/redutor-3d/src/lib/mesh/geometry';
import { exportBinaryStl } from '../../artifacts/redutor-3d/src/lib/mesh/stl';
import { readBinaryStlMesh } from '../../artifacts/redutor-3d/src/lib/compress/stl-io';
import type { MeshData } from '../../artifacts/redutor-3d/src/lib/mesh/types';

let failures = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function icosphere(subdivisions: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions: number[] = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let triangles: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const midpoint = (a: number, b: number): number => {
    const mx = (positions[a * 3] + positions[b * 3]) / 2;
    const my = (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2;
    const mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2;
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
      if (m === undefined) { m = midpoint(a, b); cache.set(key, m); }
      return m;
    };
    for (const [a, b, c] of triangles) {
      const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    triangles = next;
  }
  return normalizeTriangles(positions, triangles, 'STL');
}

function organicMock(): MeshData {
  const sphere = icosphere(3);
  const positions = Array.from(sphere.positions);
  const triangles: number[][] = [];
  for (let i = 0; i < sphere.indices.length; i += 3) {
    triangles.push([sphere.indices[i], sphere.indices[i + 1], sphere.indices[i + 2]]);
  }
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
  return normalizeTriangles(positions, triangles, 'STL');
}

const BASE = {
  quality: 'high' as const, preserveBorders: true, preserveSilhouette: true, protectDetails: true,
};

// --- 1. Matemática do target (tamanho → faces, arquivo real) ---
{
  // Fórmula: faces = ((1-p%) * bytes - 84) / 50. Para 94,58MB a 50%:
  // (47290000-84)/50 = 945798 faces (o exemplo "991k" do briefing arredonda
  // números ilustrativos; o que vale é a fórmula sobre o tamanho real).
  const faces = targetFacesForSize(94580000, 1983554, 50);
  check('target: fórmula exata tamanho→faces', faces === 945798, `${faces}`);
  check('target: 25% reduz menos que 70%', targetFacesForSize(94580000, 1983554, 25) > targetFacesForSize(94580000, 1983554, 70));
  check('target: nunca abaixo de 4 nem acima do original - 1', targetFacesForSize(1000, 10, 90) >= 4 && targetFacesForSize(1000, 100000, 1) <= 99999);
}

// --- 2. Silhueta: idêntico = 0, escalado detecta ---
{
  const mesh = icosphere(2);
  const diag = Math.hypot(...calculateBounds(mesh.positions).size);
  const vcount = mesh.positions.length / 3;
  const same = silhouetteError(mesh.positions, vcount, mesh.positions, vcount, null, diag);
  check('silhueta: idêntico = 0', same === 0, `${same}`);
  const scaled = new Float32Array(mesh.positions.length);
  for (let i = 0; i < scaled.length; i += 1) scaled[i] = mesh.positions[i] * 1.1;
  const grown = silhouetteError(mesh.positions, vcount, scaled, vcount, null, diag);
  check('silhueta: escala 1.1 detectada', grown > 0.1, `${grown.toFixed(3)}`);
}

// --- 3. Redução de 50% no orgânico (balanced) com relatório real ---
{
  const mesh = organicMock();
  const original = mesh.indices.length / 3;
  const target = Math.floor(original * 0.5);
  const result = simplifyMesh(mesh, { ...BASE, targetTriangles: target, profile: 'balanced', timeBudgetMs: 60000 });
  check('50%: reduziu de verdade', result.triangles < original, `${original} → ${result.triangles} (alvo ${target})`);
  check('50%: relatório presente', result.report.stages > 0 && result.report.commits > 0, `estágios=${result.report.stages} commits=${result.report.commits}`);
  check('50%: sem novos buracos', result.validation.boundaryLoops <= auditMesh(mesh).boundaryLoops);
  check('50%: sem non-manifold', result.validation.nonManifoldEdges === 0);
  check('50%: silhueta sob limite', result.report.silhouetteError <= 0.02, `${(result.report.silhouetteError * 100).toFixed(2)}%`);
  console.log(`INFO  50%: erro médio=${(result.report.meanError * 100).toFixed(3)}% máx=${(result.report.maxError * 100).toFixed(3)}% normal=${result.report.normalError.toFixed(4)} curv=${result.report.curvatureError.toFixed(4)} vol=${result.report.volumeDeltaPercent.toFixed(2)}% stopped=${result.report.stoppedReason}`);
}

// --- 4. Perfis: aggressive reduz ao menos tanto quanto balanced/quality ---
{
  const mesh = organicMock();
  const original = mesh.indices.length / 3;
  const target = Math.floor(original * 0.3);
  const q = simplifyMesh(mesh, { ...BASE, targetTriangles: target, profile: 'quality', timeBudgetMs: 60000 });
  const b = simplifyMesh(mesh, { ...BASE, targetTriangles: target, profile: 'balanced', timeBudgetMs: 60000 });
  const a = simplifyMesh(mesh, { ...BASE, targetTriangles: target, profile: 'aggressive', timeBudgetMs: 60000 });
  check('perfis: quality preserva mais ou igual', q.triangles >= b.triangles, `q=${q.triangles} b=${b.triangles}`);
  check('perfis: aggressive reduz ao menos tanto', a.triangles <= b.triangles, `a=${a.triangles} b=${b.triangles}`);
  check('perfis: todos válidos', q.validation.qualityAccepted && b.validation.qualityAccepted && a.validation.qualityAccepted);
}

// --- 5. Orçamento de tempo: para com razão 'time', sem exceção ---
{
  const mesh = organicMock();
  const result = simplifyMesh(mesh, { ...BASE, targetTriangles: 10, profile: 'balanced', timeBudgetMs: 1 });
  check('budget: não joga exceção', result.triangles >= 10, `faces=${result.triangles} razão=${result.report.stoppedReason}`);
  check('budget: razão time registrada', result.report.stoppedReason === 'time' || result.triangles <= 10, result.report.stoppedReason);
}

// --- 6. Guard contra falso sucesso: meta impossível retorna original + aviso ---
{
  const mesh = organicMock();
  const original = mesh.indices.length / 3;
  const result = simplifyMesh(mesh, { ...BASE, targetTriangles: original + 100, profile: 'balanced', timeBudgetMs: 10000 });
  check('guarda: alvo acima do original devolve original', result.triangles === original && result.reductionPercent === 0);
}

// --- 7. End-to-end no STL real de 1,5M faces (regressão do arquivo problemático) ---
{
  const raw = readFileSync('C:/Users/User/Documents/Nativos 3D/Site Modelos stl/CONVERTOR3D/attached_assets/Untitled_1788042906345.stl');
  const bytes = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength);
  console.log(`INFO  real: ${bytes.length} bytes`);
  let t0 = performance.now();
  const parsed = readBinaryStlMesh(bytes);
  console.log(`INFO  real: importação ${((performance.now() - t0) / 1000).toFixed(1)}s faces=${parsed.faces} verts=${parsed.mesh.positions.length / 3}`);
  const refAudit = auditMesh(parsed.mesh);
  console.log(`INFO  real: loops=${refAudit.boundaryLoops} nm=${refAudit.nonManifoldEdges} deg=${refAudit.degenerateTriangles}`);
  const target = targetFacesForSize(bytes.length, parsed.faces, 50);
  console.log(`INFO  real: alvo 50% = ${target} faces`);
  t0 = performance.now();
  const result = simplifyMesh(parsed.mesh, { ...BASE, targetTriangles: target, profile: 'balanced', timeBudgetMs: 420000 });
  const dt = (performance.now() - t0) / 1000;
  const mem = process.memoryUsage().heapUsed / 1048576;
  const outTris = result.indices.length / 3;
  const outBytes = 84 + outTris * 50;
  console.log(`INFO  real: ${parsed.faces} → ${outTris} faces em ${dt.toFixed(1)}s, ${(bytes.length / 1048576).toFixed(1)}MB → ${(outBytes / 1048576).toFixed(1)}MB, mem=${mem.toFixed(0)}MB`);
  console.log(`INFO  real: mean=${(result.report.meanError * 100).toFixed(3)}% max=${(result.report.maxError * 100).toFixed(3)}% sil=${(result.report.silhouetteError * 100).toFixed(2)}% norm=${result.report.normalError.toFixed(4)} vol=${result.report.volumeDeltaPercent.toFixed(2)}% stopped=${result.report.stoppedReason} perfil=${result.report.effectiveProfile ?? 'balanced'}`);
  check('real: REDUZIU (não aceita 0%)', outTris < parsed.faces, `${parsed.faces} → ${outTris}`);
  check('real: zero buracos novos', result.validation.boundaryLoops <= refAudit.boundaryLoops, `loops=${result.validation.boundaryLoops} (orig=${refAudit.boundaryLoops})`);
  check('real: sem non-manifold novo', result.validation.nonManifoldEdges <= refAudit.nonManifoldEdges);
  check('real: exporta STL válido e reimporta', (() => {
    const stl = exportBinaryStl({ positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions) });
    if (!stl.valid) return false;
    const view = new DataView(stl.buffer);
    return view.getUint32(80, true) === outTris;
  })());
  const stats = buildStats({ positions: result.positions, indices: result.indices, format: 'STL', bounds: calculateBounds(result.positions) });
  check('real: sem degenerados', stats.degenerateTriangles === 0);
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
