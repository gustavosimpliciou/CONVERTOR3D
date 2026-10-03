import { MeshoptSimplifier } from 'meshoptimizer';
import { compactMesh, triangleAreaSquared } from './geometry';
import { ensureReport } from './processor';
import { approximateSurfaceError } from './safeguards';
import { auditMesh, auditWithinTolerance } from './validation';
import type { MeshData, SimplifyOptions, SimplifyResult } from './types';


export function disconnectedVertexFans(indices: Uint32Array, vertexCount: number): Set<number> {
  const defects = new Set<number>();
      const head = new Int32Array(vertexCount).fill(-1);
      const next = new Int32Array(indices.length);
      for (let corner = 0; corner < indices.length; corner++) { const vertex = indices[corner]; next[corner] = head[vertex]; head[vertex] = corner; }
      for (let vertex = 0; vertex < head.length; vertex++) {
        if (head[vertex] < 0) continue;
        const link = new Map<number, number[]>();
        for (let corner = head[vertex]; corner >= 0; corner = next[corner]) {
          const base = corner - corner % 3;
          const a = indices[base + (corner % 3 + 1) % 3], b = indices[base + (corner % 3 + 2) % 3];
          if (!link.has(a)) link.set(a, []); if (!link.has(b)) link.set(b, []);
          link.get(a)!.push(b); link.get(b)!.push(a);
        }
        const visited = new Set<number>();
        const stack = [link.keys().next().value as number];
        while (stack.length) { const point = stack.pop()!; if (visited.has(point)) continue; visited.add(point); for (const neighbor of link.get(point) ?? []) if (!visited.has(neighbor)) stack.push(neighbor); }
        if (visited.size !== link.size) { defects.add(vertex); }
      }
  return defects;
}

/** STL geometry only: fixed quality limits, independent validation, original on failure. */
export async function reduceStlQuality(mesh: MeshData, options: SimplifyOptions, progress?: (value: number) => void): Promise<SimplifyResult> {
  const started = performance.now();
  const originalFaces = mesh.indices.length / 3;
  const reference = auditMesh(mesh);
  if (!reference.valid) throw new Error(`O STL original precisa de revisão antes da redução: ${reference.reasons.join(' ')}`);
  const diagonal = Math.hypot(...mesh.bounds.size) || 1;
  const maxError = options.limits?.maxMaxError ?? 0.0005;
  const meanLimit = options.limits?.maxMeanError ?? 0.00025;
  const volumeLimit = options.limits?.maxVolumeError ?? 0.5;
  const target = Math.max(4, Math.min(originalFaces, Math.floor(options.targetTriangles)));
  let output = mesh;
  let audit = reference;
  let mean = 0;
  let max = 0;
  let volume = 0;
  let attempts = 0;
  const locks = new Uint8Array(mesh.positions.length / 3);
  const attributes = new Float32Array(locks.length);
  const warnings: string[] = [];
  const referenceFans = disconnectedVertexFans(mesh.indices, locks.length);
  for (const vertex of referenceFans) locks[vertex] = 1;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
    if (referenceFans.has(a) || referenceFans.has(b) || referenceFans.has(c)) locks[a] = locks[b] = locks[c] = 1;
  }
  if (referenceFans.size) warnings.push(`O original contém ${referenceFans.size} vértice(s) com superfícies em contato; esses pontos foram preservados.`);
  let stop: 'target' | 'quality' | 'time' = 'quality';
  if (!MeshoptSimplifier.supported) throw new Error('Este navegador não oferece WebAssembly para a redução.');
  await MeshoptSimplifier.ready;
  for (let attempt = 0; attempt < 16 && target < originalFaces; attempt++) {
    if (performance.now() - started > (options.timeBudgetMs ?? 55000)) { stop = 'time'; break; }
    attempts++;
    progress?.(0.1 + attempt * 0.03);
    // Error is in source coordinate units; retries tighten it, never relax it.
    const retryTarget = attempt < 14 ? target : Math.max(target, Math.floor(originalFaces * [0.5, 0.9][attempt - 14]));
    const [indices] = MeshoptSimplifier.simplifyWithAttributes(mesh.indices, mesh.positions, 3, attributes, 1, [0], locks, retryTarget * 3, maxError * diagonal / 2 ** Math.min(3, Math.max(0, attempt - 2)), ['LockBorder', 'ErrorAbsolute']);
    // Protect the source neighborhoods of topology defects detected in a trial.
    // Every retry starts from the original, retaining those neighborhoods verbatim.
    const edgeCounts = new Map<number, number>();
    const stride = locks.length;
    const protect = new Set<number>();
    for (let i = 0; i < indices.length; i += 3) {
      const a = indices[i], b = indices[i + 1], c = indices[i + 2];
      if (triangleAreaSquared(mesh.positions, indices, i / 3) <= 0) { protect.add(a); protect.add(b); protect.add(c); }
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = Math.min(u, v) * stride + Math.max(u, v);
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
    for (const [key, count] of edgeCounts) if (count > 2) { protect.add(Math.floor(key / stride)); protect.add(key % stride); }
    // Edge counts alone miss a pinched vertex with two disjoint surface fans.
    if (protect.size === 0) {
      for (const vertex of disconnectedVertexFans(indices, locks.length)) if (!referenceFans.has(vertex)) protect.add(vertex);
    }
    if (protect.size > 0) {
      for (let ring = 0; ring < 3; ring++) {
        const neighbors = new Set(protect);
        for (let i = 0; i < mesh.indices.length; i += 3) {
          const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
          if (protect.has(a) || protect.has(b) || protect.has(c)) { locks[a] = locks[b] = locks[c] = 1; neighbors.add(a); neighbors.add(b); neighbors.add(c); }
        }
        for (const vertex of neighbors) protect.add(vertex);
      }
      if ((globalThis as Record<string, unknown>).__MESH_DEBUG) console.log('protected trial', attempt, indices.length / 3, protect.size);
      continue;
    }
    if (indices.length >= mesh.indices.length) break;
    const candidate = compactMesh(mesh.positions, indices, 'STL');
    const candidateAudit = auditMesh(candidate, reference);
    const volumeChange = Math.abs(Math.abs(candidateAudit.volume) - Math.abs(reference.volume)) /
      Math.max(Math.abs(reference.volume), Math.max(...reference.bounds.size, 1e-9) ** 3 * 1e-6) * 100;
    if ((globalThis as Record<string, unknown>).__MESH_DEBUG) console.log('candidate', indices.length / 3, candidateAudit.reasons, candidateAudit.components, volumeChange);
    const sameEuler = reference.boundaryEdges > 0 || candidate.positions.length / 3 - candidate.indices.length / 6 === mesh.positions.length / 3 - mesh.indices.length / 6;
    if (!sameEuler || !candidateAudit.valid || candidateAudit.nonManifoldEdges !== 0 || candidateAudit.degenerateTriangles !== 0 || volumeChange > volumeLimit || !auditWithinTolerance(candidateAudit, reference, 0.002)) continue;
    progress?.(0.3 + attempt * 0.03);
    const forward = approximateSurfaceError(mesh, candidate, diagonal, 3000);
    const backward = approximateSurfaceError(candidate, mesh, diagonal, 3000);
    const candidateMean = Math.max(forward.mean, backward.mean);
    const candidateMax = Math.max(forward.max, backward.max);
    if ((globalThis as Record<string, unknown>).__MESH_DEBUG) console.log('surface', candidateMean, candidateMax);
    if (!Number.isFinite(candidateMax) || candidateMean > meanLimit || candidateMax > maxError) continue;
    output = candidate; audit = candidateAudit; mean = candidateMean; max = candidateMax; volume = volumeChange;
    stop = indices.length / 3 <= target ? 'target' : 'quality';
    break;
  }
  if (output.indices.length / 3 > target) warnings.push('O alvo não foi atingido: os limites de qualidade foram mantidos. O original permanece disponível.');
  progress?.(1);
  const boundsDelta = Math.max(...audit.bounds.min.map((v, i) => Math.abs(v - reference.bounds.min[i])), ...audit.bounds.max.map((v, i) => Math.abs(v - reference.bounds.max[i]))) / Math.max(...reference.bounds.size, 1e-9) * 100;
  return {
    positions: output.positions, indices: output.indices,
    triangles: output.indices.length / 3, vertices: output.positions.length / 3,
    reductionPercent: (1 - output.indices.length / mesh.indices.length) * 100,
    warnings, stoppedSafely: stop !== 'target', elapsedMs: performance.now() - started,
    validation: { watertight: audit.boundaryLoops === 0 && audit.nonManifoldEdges === 0 && audit.orientationConflicts === 0, boundaryLoops: audit.boundaryLoops, nonManifoldEdges: audit.nonManifoldEdges, volumeDeltaPercent: volume, boundsDeltaPercent: boundsDelta, qualityAccepted: true },
    report: { ...ensureReport(null), engine: 'meshoptimizer', stages: attempts, commits: Math.max(0, (mesh.indices.length - output.indices.length) / 6), meanError: mean, maxError: max, hausdorffApprox: max, volumeDeltaPercent: volume, areaDeltaPercent: Math.abs(audit.surfaceArea - reference.surfaceArea) / Math.max(reference.surfaceArea, 1e-24) * 100, boundaryOriginal: reference.boundaryLoops, boundaryFinal: audit.boundaryLoops, nonManifoldEdges: audit.nonManifoldEdges, degenerateTriangles: audit.degenerateTriangles, stoppedReason: stop, effectiveProfile: 'quality', components: audit.components, errorBudget: maxError, targetTooAggressive: output.indices.length / 3 > target, safeTriangleSuggestion: output.indices.length / 3 },
  };
}
