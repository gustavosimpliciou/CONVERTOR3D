import { buildStats, compareMeshes } from './geometry';
import { parseMesh } from './parser';
import { simplifyMesh } from './simplifier';
import { exportBinaryStl } from './stl';
import type { MeshData, SimplifyOptions, WorkerFailure, WorkerProgress, WorkerRequest, WorkerSuccess, SimplificationAttempt } from './types';

const post = (message: WorkerProgress | WorkerSuccess | WorkerFailure, transfer: Transferable[] = []) => self.postMessage(message, { transfer });
const optionsFrom = (request: WorkerRequest, targetTriangles: number, deadlineMs: number): SimplifyOptions => ({ targetTriangles, quality: request.quality, preserveBorders: request.preserveBorders, preserveSilhouette: request.preserveSilhouette, protectDetails: request.protectDetails, deadlineMs });

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== 'process') return;
  const request = event.data;
  try {
    post({ type: 'progress', phase: 'loading', progress: 0.04, message: 'Lendo a estrutura do arquivo…' });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    post({ type: 'progress', phase: 'analyzing', progress: 0.18, message: 'Analisando geometria e topologia…', stats: original });
    const requested = Math.max(4, Math.floor(request.targetTriangles));
    const startedAt = performance.now();
    const deadline = startedAt + 58_000;
    const targets = [...new Set([requested, Math.ceil(requested * 1.1), Math.ceil(requested * 1.3), Math.ceil(requested * 1.6), Math.ceil(requested * 2)])].filter((target) => target < original.triangles);
    const attempts: SimplificationAttempt[] = [];
    let approved: { mesh: MeshData; stats: ReturnType<typeof buildStats>; comparison: ReturnType<typeof compareMeshes>; warnings: string[] } | undefined;
    for (let index = 0; index < targets.length; index += 1) {
      if (performance.now() >= deadline) break;
      const target = targets[index];
      const result = simplifyMesh(mesh, optionsFrom(request, target, Math.max(250, deadline - performance.now())), (progress) => post({ type: 'progress', phase: 'simplifying', progress: 0.2 + ((index + progress / Math.max(1, targets.length)) / Math.max(1, targets.length)) * 0.58, message: 'Simplificando sem romper a topologia…' }));
      const reducedMesh: MeshData = { positions: result.positions, indices: result.indices, format: mesh.format, bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds };
      const reduced = buildStats(reducedMesh); const comparison = compareMeshes(original, reduced);
      const accepted = reduced.finite && reduced.degenerateTriangles <= original.degenerateTriangles && comparison.newOpenEdges === 0 && comparison.newNonManifoldEdges === 0 && comparison.severity !== 'error';
      attempts.push({ target, triangles: reduced.triangles, accepted, reason: accepted ? undefined : 'A validação geométrica rejeitou esta meta.' });
      if (accepted && (!approved || reduced.triangles < approved.stats.triangles)) approved = { mesh: reducedMesh, stats: reduced, comparison, warnings: result.warnings };
      if (accepted && reduced.triangles <= requested) break;
    }
    if (!approved) {
      // Alguns modelos CAD, escaneamentos e malhas abertas não permitem colapsos
      // que preservem todas as métricas. Nesse caso, ainda entregamos um STL
      // válido da malha original em vez de bloquear o upload.
      const originalMesh = mesh;
      const originalComparison = compareMeshes(original, original);
      approved = {
        mesh: originalMesh,
        stats: original,
        comparison: originalComparison,
        warnings: ['Não foi possível reduzir sem alterar a integridade desta malha; o arquivo original foi preservado e exportado com segurança.'],
      };
      attempts.push({ target: requested, triangles: original.triangles, accepted: true, reason: 'Fallback de integridade: malha original preservada.' });
    }
    post({ type: 'progress', phase: 'validating', progress: 0.86, message: 'Validando a malha reduzida…', stats: approved.stats });
    const stl = exportBinaryStl(approved.mesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');
    post({ type: 'progress', phase: 'exporting', progress: 0.96, message: 'Gerando STL binário validado…' });
    const complete: WorkerSuccess = { type: 'complete', original, reduced: approved.stats, comparison: approved.comparison, attempts, targetReached: approved.stats.triangles <= requested, stl, positions: approved.mesh.positions, indices: approved.mesh.indices, warnings: [...approved.warnings, ...(original.degenerateTriangles ? ['Faces degeneradas foram descartadas durante a importação.'] : []), ...(approved.stats.triangles > requested ? ['A maior redução segura ficou acima da meta solicitada; a forma foi priorizada.'] : [])], format: mesh.format };
    post(complete, [approved.mesh.positions.buffer, approved.mesh.indices.buffer, stl.buffer]);
  } catch (error) {
    post({ type: 'error', message: error instanceof Error ? error.message : 'Não foi possível processar este modelo com segurança.', technical: error instanceof Error ? error.stack : String(error) });
  }
};
