import { buildStats } from './geometry';
import { auditMesh, auditWithinTolerance } from './validation';
import { parseMesh } from './parser';
import { simplifyMesh } from './simplifier';
import { exportBinaryStl } from './stl';
import type { MeshData, WorkerFailure, WorkerProgress, WorkerRequest, WorkerSuccess } from './types';

const post = (message: WorkerProgress | WorkerSuccess | WorkerFailure, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

self.onmessage = (event: MessageEvent<WorkerRequest>) => {
  if (event.data.type !== 'process') return;
  const request = event.data;
  const started = performance.now();
  try {
    post({ type: 'progress', phase: 'loading', progress: 0.04, message: 'Lendo a estrutura do arquivo…' });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    post({ type: 'progress', phase: 'analyzing', progress: 0.18, message: 'Analisando geometria e topologia…', stats: original });
    const result = simplifyMesh(mesh, {
      targetTriangles: request.targetTriangles,
      quality: request.quality,
      preserveBorders: request.preserveBorders,
      preserveSilhouette: request.preserveSilhouette,
      protectDetails: request.protectDetails,
      timeBudgetMs: request.timeBudgetMs ?? 55_000,
      onCheckpoint: () => {
        post({ type: 'progress', phase: 'simplifying', progress: 0.2, message: 'Simplificando com preservação de detalhes…', elapsedMs: performance.now() - started, originalTriangles: original.triangles, targetTriangles: request.targetTriangles });
        return true;
      },
    });
    const reducedMesh: MeshData = {
      positions: result.positions,
      indices: result.indices,
      format: mesh.format,
      bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds,
    };
    const reduced = buildStats(reducedMesh);
    const referenceAudit = auditMesh(mesh);
    const finalAudit = auditMesh(reducedMesh, referenceAudit);
    if (!finalAudit.valid || !auditWithinTolerance(finalAudit, referenceAudit)) {
      throw new Error(`A malha reduzida não passou na validação final: ${finalAudit.reasons.join(' ') || 'tolerância geométrica excedida.'}`);
    }
    post({ type: 'progress', phase: 'validating', progress: 0.86, message: 'Validando a malha reduzida…', stats: reduced, elapsedMs: performance.now() - started, originalTriangles: original.triangles, targetTriangles: request.targetTriangles });
    const stl = exportBinaryStl(reducedMesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');
    post({ type: 'progress', phase: 'exporting', progress: 0.96, message: 'Gerando STL binário validado…' });
    const complete: WorkerSuccess = {
      type: 'complete',
      original,
      reduced,
      stl,
      positions: result.positions,
      indices: result.indices,
      warnings: [...result.warnings, ...(original.degenerateTriangles ? ['Faces degeneradas foram descartadas durante a importação.'] : [])],
      validation: result.validation,
      format: mesh.format,
    };
    post(complete, [result.positions.buffer, result.indices.buffer, stl.buffer]);
    void started;
  } catch (error) {
    const failure: WorkerFailure = {
      type: 'error',
      message: error instanceof Error ? error.message : 'Não foi possível processar este modelo com segurança.',
      technical: error instanceof Error ? error.stack : String(error),
    };
    post(failure);
  }
};
