import { buildStats } from './geometry';
import { auditMesh, auditWithinTolerance } from './validation';
import { parseMesh } from './parser';
import { simplifyMesh } from './simplifier';
import { exportBinaryStl } from './stl';
import { NotStlError, parseStlForImport } from './stl-import';
import type {
  ImportRequest,
  ImportSuccess,
  MeshData,
  WorkerFailure,
  WorkerProgress,
  WorkerRequest,
  WorkerSuccess,
} from './types';
import { MESH_PROTOCOL } from './types';

const post = (
  message: WorkerProgress | WorkerSuccess | ImportSuccess | WorkerFailure,
  transfer: Transferable[] = [],
) => self.postMessage(message, { transfer });

/**
 * IMPORTAÇÃO (upload): só lê e valida a ESTRUTURA. Nunca reduz, nunca
 * avalia target. Falha SOMENTE se o arquivo for ilegível.
 */
async function handleImport(request: ImportRequest): Promise<void> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const bytes = new Uint8Array(request.buffer);
  const progress = (p: number, message: string): void => {
    const update: WorkerProgress = {
      type: 'progress', phase: 'analyzing', progress: p, message,
      stage: 'ANALISANDO', elapsedMs: elapsed(), originalBytes: bytes.length,
    };
    post(update);
  };
  progress(0.1, 'Lendo a estrutura do arquivo…');
  let imported;
  try {
    imported = parseStlForImport(bytes, request.fileName);
  } catch (error) {
    if (error instanceof NotStlError) {
      // Formatos não-STL: parser geral (mantém OBJ/PLY/etc. funcionando).
      const mesh = parseMesh(request.buffer, request.fileName);
      const stats = buildStats(mesh);
      if (stats.triangles === 0) throw new Error('O arquivo não contém geometria válida (0 faces).');
      const audit = auditMesh(mesh);
      imported = {
        mesh,
        stats,
        formatLabel: mesh.format,
        audit,
        quirks: audit.boundaryLoops > 0
          ? [`Modelo com ${audit.boundaryLoops.toLocaleString('pt-BR')} abertura(s) original(is) — serão preservadas.`]
          : [],
      };
    } else {
      throw error;
    }
  }
  progress(0.85, 'Validando a estrutura do arquivo…');
  const done: ImportSuccess = {
    type: 'complete',
    job: 'import',
    protocol: MESH_PROTOCOL,
    positions: imported.mesh.positions,
    indices: imported.mesh.indices,
    stats: imported.stats,
    formatLabel: imported.formatLabel,
    format: imported.mesh.format,
    topology: {
      boundaryLoops: imported.audit.boundaryLoops,
      nonManifoldEdges: imported.audit.nonManifoldEdges,
      components: imported.audit.components,
      degenerateTriangles: imported.audit.degenerateTriangles,
      watertight: imported.audit.boundaryLoops === 0,
      volume: imported.audit.volume,
    },
    quirks: imported.quirks,
    elapsedMs: performance.now() - started,
  };
  self.postMessage(done, {
    transfer: [imported.mesh.positions.buffer, imported.mesh.indices.buffer],
  });
}

self.onmessage = (event: MessageEvent<ImportRequest | WorkerRequest>) => {
  if (event.data.type === 'import') {
    handleImport(event.data).catch((error: unknown) => {
      const failure: WorkerFailure = {
        type: 'error',
        code: 'UNREADABLE',
        message: error instanceof Error ? error.message : 'Arquivo inválido.',
        technical: error instanceof Error ? error.stack : String(error),
      };
      post(failure);
    });
    return;
  }
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
      // Upload continua válido: o MODELO está carregado, só a redução não
      // avançou. A UI mostra isso como aviso (não como "não pôde ser lido").
      const error = new Error(
        'Nenhuma redução segura foi possível para este modelo com os limites atuais — o original foi preservado intacto. Tente o perfil Máximo ou a aba Sem alterar malha.',
      ) as Error & { code?: string };
      error.code = 'ZERO_REDUCTION';
      throw error;
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
    protocol: MESH_PROTOCOL,
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
      code: (error as { code?: 'ZERO_REDUCTION' })?.code,
    };
    post(failure);
  }
};
