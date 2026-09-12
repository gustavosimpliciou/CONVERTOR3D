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
  const elapsed = (): number => performance.now() - started;
  try {
    // 1. UPLOAD → PARSE → RECONSTRUCTION → VALIDATION (importação preservada)
    post({
      type: 'progress', phase: 'loading', progress: 0.04,
      message: 'Lendo a estrutura do arquivo…', stage: 'ANALISANDO',
      targetTriangles: request.targetTriangles, elapsedMs: elapsed(),
    });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    const originalBytes = request.buffer.byteLength;

    // Referência original imutável: todas as comparações usam esta malha.
    post({
      type: 'progress', phase: 'analyzing', progress: 0.12,
      message: `Analisando geometria e topologia — ${original.triangles.toLocaleString('pt-BR')} faces…`,
      stage: 'ANALISANDO', stats: original, elapsedMs: elapsed(),
      originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
      currentTriangles: original.triangles, originalBytes,
    });

    post({
      type: 'progress', phase: 'analyzing', progress: 0.18,
      message: 'Identificando features — curvatura, relevos, silhueta…',
      stage: 'IDENTIFICANDO_FEATURES', stats: original, elapsedMs: elapsed(),
      originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
      currentTriangles: original.triangles, originalBytes,
    });

    // 2. FEATURE LOCK → DECIMAÇÃO ADAPTATIVA PROGRESSIVA (estágios + rollback)
    const result = simplifyMesh(mesh, {
      targetTriangles: request.targetTriangles,
      quality: request.quality,
      preserveBorders: request.preserveBorders,
      preserveSilhouette: request.preserveSilhouette,
      protectDetails: request.protectDetails,
      timeBudgetMs: request.timeBudgetMs ?? 55_000,
      profile: request.profile,
      limits: request.limits,
      onCheckpoint: (activeTriangles) => {
        const done = 1 - (activeTriangles - request.targetTriangles) / Math.max(1, original.triangles - request.targetTriangles);
        const reduction = ((original.triangles - activeTriangles) / Math.max(1, original.triangles)) * 100;
        post({
          type: 'progress', phase: 'simplifying',
          progress: Math.min(0.84, Math.max(0.2, 0.2 + Math.max(0, Math.min(1, done)) * 0.64)),
          message: `Otimizando — ${activeTriangles.toLocaleString('pt-BR')} faces (−${reduction.toFixed(1)}%)…`,
          stage: 'OTIMIZANDO', elapsedMs: elapsed(),
          originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
          currentTriangles: activeTriangles, originalBytes,
        });
        return true;
      },
    }, (progress) => {
      post({
        type: 'progress', phase: 'simplifying', progress: 0.2 + progress * 0.64,
        message: 'Otimizando com preservação de features…', stage: 'OTIMIZANDO',
        elapsedMs: elapsed(), originalTriangles: original.triangles,
        targetTriangles: request.targetTriangles, originalBytes,
      });
    });

    const reducedMesh: MeshData = {
      positions: result.positions,
      indices: result.indices,
      format: mesh.format,
      bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds,
    };
    const reduced = buildStats(reducedMesh);
    const reductionPercent = ((original.triangles - reduced.triangles) / Math.max(1, original.triangles)) * 100;

    // 3. VALIDAÇÃO 3D (matemática + topológica + geométrica)
    post({
      type: 'progress', phase: 'validating', progress: 0.87,
      message: `Validando — ${reduced.triangles.toLocaleString('pt-BR')} faces, watertight=${result.validation.watertight ? 'sim' : 'não'}…`,
      stage: 'VALIDANDO', stats: reduced, elapsedMs: elapsed(),
      originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
      currentTriangles: reduced.triangles, originalBytes,
    });
    const referenceAudit = auditMesh(mesh);
    const finalAudit = auditMesh(reducedMesh, referenceAudit);
    const madeProgress = reduced.triangles < original.triangles;
    if ((!finalAudit.valid || !auditWithinTolerance(finalAudit, referenceAudit)) && !madeProgress) {
      throw new Error(`A malha reduzida não passou na validação final: ${finalAudit.reasons.join(' ') || 'tolerância geométrica excedida.'}`);
    }
    if (!madeProgress) {
      throw new Error('Nenhuma redução segura foi possível para este modelo — o original foi preservado intacto.');
    }

    // 4. EXPORTAÇÃO → REIMPORTAÇÃO REAL (o STL só é liberado validado)
    post({
      type: 'progress', phase: 'exporting', progress: 0.95,
      message: 'Finalizando — gerando STL binário validado…',
      stage: 'FINALIZANDO', stats: reduced, elapsedMs: elapsed(),
      originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
      currentTriangles: reduced.triangles, originalBytes,
    });
    const stl = exportBinaryStl(reducedMesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');
    // Reimporta o buffer exportado e confere contagem + topologia.
    const reimported = parseMesh(stl.buffer.slice(0), `${request.fileName.replace(/\.[^.]+$/, '')}_reduzido.stl`);
    const reimportedAudit = auditMesh(
      { positions: reimported.positions, indices: reimported.indices, format: 'STL', bounds: reimported.bounds },
      referenceAudit,
    );
    if (reimported.indices.length / 3 !== reduced.triangles) {
      throw new Error('O STL exportado não contém as faces esperadas após reimportação.');
    }
    if (reimportedAudit.boundaryLoops > referenceAudit.boundaryLoops || reimportedAudit.nonManifoldEdges > referenceAudit.nonManifoldEdges) {
      throw new Error('O STL exportado perdeu integridade topológica na reimportação.');
    }
    post({
      type: 'progress', phase: 'exporting', progress: 0.99,
      message: `Pronto — ${reduced.triangles.toLocaleString('pt-BR')} faces (−${reductionPercent.toFixed(1)}%) em ${(elapsed() / 1000).toFixed(1)}s.`,
      stage: 'FINALIZANDO', stats: reduced, elapsedMs: elapsed(),
      originalTriangles: original.triangles, targetTriangles: request.targetTriangles,
      currentTriangles: reduced.triangles, originalBytes,
    });

    const complete: WorkerSuccess = {
      type: 'complete',
      original,
      reduced,
      stl,
      positions: result.positions,
      indices: result.indices,
      warnings: [...result.warnings, ...(original.degenerateTriangles ? ['Faces degeneradas foram descartadas durante a importação.'] : [])],
      validation: result.validation,
      report: result.report,
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
