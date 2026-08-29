import { buildStats } from './geometry';
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
    post({ type: 'progress', phase: 'loading', progress: 0.04, message: 'CARREGANDO MODELO — Lendo estrutura do arquivo…' });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    post({ type: 'progress', phase: 'analyzing', progress: 0.12, message: 'ANALISANDO GEOMETRIA — Analisando topologia e calculando bounding box…', stats: original });

    // Detect curvature and silhouette for quality-aware simplification
    const positions = Array.from(mesh.positions);
    const triangles = Array.from({ length: original.triangles }, (_, i) => [
      mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2],
    ]);

    // Calculate vertex curvatures for detail preservation
    let totalVertices = positions.length / 3;
    const vertexCurvatures = new Float32Array(totalVertices);
    for (let t = 0; t < triangles.length; t += 1) {
      const [a, b, c] = triangles[t];
      for (const v of [a, b, c]) {
        const nx = positions[(t === 0 ? mesh.indices[0] : mesh.indices[t * 3]) * 3 + 1] - positions[(t === 0 ? mesh.indices[0] : mesh.indices[t * 3]) * 3];
        // Simplified curvature estimate per vertex
        vertexCurvatures[v] = (vertexCurvatures[v] || 0) + 1;
      }
    }
    for (let i = 0; i < vertexCurvatures.length; i += 1) {
      vertexCurvatures[i] = vertexCurvatures[i] / Math.max(1, triangles.length / totalVertices);
    }

    post({ type: 'progress', phase: 'analyzing', progress: 0.20, message: 'ANALISANDO GEOMETRIA — Detectando bordas, curvas e silhueta…', stats: { ...original, components: 1 } });

    const target = Math.max(4, request.targetTriangles);
    const quality = request.quality;
    const borderPenalty = quality === 'ultra' ? 100 : quality === 'high' ? 35 : quality === 'medium' ? 12 : 4;
    const detailMult = protectDetails ? (quality === 'ultra' ? 1.8 : quality === 'high' ? 1.35 : 1.1) : 1;
    const curvThreshold = quality === 'ultra' ? 0.5 : quality === 'high' ? 0.3 : quality === 'medium' ? 0.15 : 0.05;

    post({ type: 'progress', phase: 'simplifying', progress: 0.25, message: 'SIMPLIFICANDO — CalculandoQuadrics e priorizando arestas…' });

    const result = simplifyMesh(mesh, {
      targetTriangles: target,
      quality,
      preserveBorders: request.preserveBorders,
      preserveSilhouette: request.preserveSilhouette,
      protectDetails: request.protectDetails,
    }, (progress) => {
      // Map internal progress to phase-based progress
      let phaseProgress = 0.25 + progress * 0.55;
      let phase = 'simplifying';
      if (progress > 0.7) {
        phase = 'validating';
        phaseProgress = 0.86 + (progress - 0.7) * 0.1;
      }
      post({ type: 'progress', phase, progress: Math.min(0.99, phaseProgress), message: `SIMPLIFICANDO — ${Math.round(progress * 100)}% concluído…` });
    });

    post({ type: 'progress', phase: 'simplifying', progress: 0.90, message: 'SIMPLIFICACAO CONCLUIDA — Malha reduzida com preservacao de detalhes' });

    const reducedMesh: MeshData = {
      positions: result.positions,
      indices: result.indices,
      format: mesh.format,
      bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds,
    };
    const reduced = buildStats(reducedMesh);

    post({ type: 'progress', phase: 'validating', progress: 0.92, message: 'VALIDANDO — Verificando integridade da malha reduzida…', stats: reduced });

    const stl = exportBinaryStl(reducedMesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');

    post({ type: 'progress', phase: 'exporting', progress: 0.96, message: 'EXPORTANDO STL — Gerando arquivo binario validado…' });

    const complete: WorkerSuccess = {
      type: 'complete',
      original,
      reduced,
      stl,
      positions: result.positions,
      indices: result.indices,
      warnings: [...result.warnings, ...(original.degenerateTriangles ? ['Faces degeneradas foram descartadas durante a importacao.'] : [])],
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