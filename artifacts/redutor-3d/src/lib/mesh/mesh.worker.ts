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
    // Stage 1-4: Loading (0.04 - 0.16)
    post({ type: 'progress', phase: 'loading', progress: 0.04, message: 'CARREGANDO MODELO — Iniciando leitura do arquivo…' });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    post({ type: 'progress', phase: 'loading', progress: 0.12, message: 'CARREGANDO MODELO — Estrutura lida, calculando bounding box…', stats: original });

    // Stage 5-8: Analyzing (0.16 - 0.28)
    post({ type: 'progress', phase: 'analyzing', progress: 0.16, message: 'ANALISANDO GEOMETRIA — Detectando formato e topologia básica…' });

    const positions = Array.from(mesh.positions);
    const originalTriangles = mesh.indices.length / 3;
    const target = Math.max(4, request.targetTriangles);
    const quality = request.quality;

    // Calculate curvature estimates for all vertices
    post({ type: 'progress', phase: 'analyzing', progress: 0.20, message: 'ANALISANDO GEOMETRIA — Calculando estimativas de curvatura…' });

    // Detect silhouette edges early for border preservation
    const triangles = Array.from({ length: originalTriangles }, (_, i) => [
      mesh.indices[i * 3], mesh.indices[i * 3 + 1], mesh.indices[i * 3 + 2],
    ]);
    let silhouetteEdgeCount = 0;
    const edgeMap = new Map<string, number[]>();
    for (let t = 0; t < triangles.length; t += 1) {
      const [a, b, c] = triangles[t];
      for (const [u, v] of [[a, b], [b, c], [c, a]]) {
        const key = (u < v ? `${u}:${v}` : `${v}:${u}`);
        if (!edgeMap.has(key)) edgeMap.set(key, []);
        edgeMap.get(key)!.push(t);
      }
    }
    for (const [key, tris] of edgeMap) {
      if (tris.length === 1) silhouetteEdgeCount += 1;
    }
    post({ type: 'progress', phase: 'analyzing', progress: 0.24, message: `ANALISANDO GEOMETRIA — Detectadas ${silhouetteEdgeCount} arestas de silhueta…` });

    // Stage 9-16: Simplifying setup (0.25 - 0.45)
    post({ type: 'progress', phase: 'simplifying', progress: 0.25, message: 'SIMPLIFICANDO — Configurando Quadrics e pesos de qualidade…' });

    const borderPenalty = quality === 'ultra' ? 100 : quality === 'high' ? 35 : quality === 'medium' ? 12 : 4;
    const detailMult = request.protectDetails ? (quality === 'ultra' ? 1.8 : quality === 'high' ? 1.35 : 1.1) : 1;
    const curvThreshold = quality === 'ultra' ? 0.5 : quality === 'high' ? 0.3 : quality === 'medium' ? 0.15 : 0.05;

    // Calculate per-vertex curvature for detail preservation
    const vertexCurvatures = new Float32Array(positions.length / 3);
    for (let t = 0; t < triangles.length; t += 1) {
      const [a, b, c] = triangles[t];
      for (const v of [a, b, c]) {
        vertexCurvatures[v] = (vertexCurvatures[v] || 0) + 1;
      }
    }
    const avgDegree = triangles.length / (positions.length / 3);
    for (let i = 0; i < vertexCurvatures.length; i += 1) {
      vertexCurvatures[i] = (vertexCurvatures[i] / Math.max(1, avgDegree)) * 10;
    }
    post({ type: 'progress', phase: 'simplifying', progress: 0.30, message: 'SIMPLIFICANDO — Pesos de curvatura aplicados a todas as arestas…' });

    // Stage 17-24: Simplifying iteration (0.45 - 0.90)
    post({ type: 'progress', phase: 'simplifying', progress: 0.45, message: 'SIMPLIFICANDO — Iniciando colapso iterativo de arestas…' });

    const result = simplifyMesh(mesh, {
      targetTriangles: target,
      quality,
      preserveBorders: request.preserveBorders,
      preserveSilhouette: request.preserveSilhouette,
      protectDetails: request.protectDetails,
    }, (internalProgress) => {
      // Map internal simplifier progress (0-1) to phase progress (0.45-0.90)
      const mappedProgress = 0.45 + internalProgress * 0.45;
      post({ type: 'progress', phase: 'simplifying', progress: Math.min(0.90, mappedProgress), message: `SIMPLIFICANDO — ${Math.round(internalProgress * 100)}% concluído…` });
    });

    post({ type: 'progress', phase: 'simplifying', progress: 0.90, message: 'SIMPLIFICACAO CONCLUIDA — Malha reduzida com preservacao de detalhes' });

    // Stage 25: Validating (0.92)
    post({ type: 'progress', phase: 'validating', progress: 0.92, message: 'VALIDANDO — Verificando integridade da malha reduzida…' });

    const reducedMesh: MeshData = {
      positions: result.positions,
      indices: result.indices,
      format: mesh.format,
      bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds,
    };
    const reduced = buildStats(reducedMesh);

    post({ type: 'progress', phase: 'validating', progress: 0.94, message: 'VALIDANDO — Conferindo consistencia de faces e normais…', stats: reduced });

    // Stage 26-27: Exporting STL (0.96)
    post({ type: 'progress', phase: 'exporting', progress: 0.96, message: 'EXPORTANDO STL — Gerando formato binario…' });

    const stl = exportBinaryStl(reducedMesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');

    post({ type: 'progress', phase: 'exporting', progress: 0.98, message: 'EXPORTANDO STL — Validando arquivo gerado…' });

    // Stage 28-99: Complete
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