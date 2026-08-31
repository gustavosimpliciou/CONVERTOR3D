import { buildStats, calculateBounds, compactMesh } from './geometry';
import { parseMesh } from './parser';
import { simplifyMesh } from './simplifier';
import { exportBinaryStl } from './stl';
import { taubinSmoothing } from './mesh-postprocess';
import type { MeshData, WorkerFailure, WorkerProgress, WorkerRequest, WorkerSuccess } from './types';

const post = (message: WorkerProgress | WorkerSuccess | WorkerFailure, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

self.onmessage = (event: MessageEvent<any>) => {
  if (event.data.type !== 'process') return;
  const request = event.data;
  const started = performance.now();
  
  try {
    post({ type: 'progress', phase: 'loading', progress: 0.04, message: 'Lendo a estrutura do arquivo…' });
    const mesh = parseMesh(request.buffer, request.fileName);
    const original = buildStats(mesh);
    post({ type: 'progress', phase: 'analyzing', progress: 0.15, message: 'Analisando geometria e detectando features…', stats: original });
    
    // Use working simplifyMesh with robust options
    const result = simplifyMesh(mesh, {
      targetTriangles: request.targetTriangles,
      quality: request.quality,
      preserveBorders: request.preserveBorders,
      preserveSilhouette: request.preserveSilhouette,
      protectDetails: request.protectDetails,
      distributeFacesProportionally: request.distributeFacesProportionally,
    }, (progress) => post({ type: 'progress', phase: 'simplifying', progress: 0.2 + progress * 0.55, message: `Simplificando... ${Math.round(progress * 100)}%` }));
    
    post({ type: 'progress', phase: 'postprocessing', progress: 0.8, message: 'Aplicando pós-processamento...' });
    
    const simplifiedMesh: MeshData = {
      positions: result.positions,
      indices: result.indices,
      format: mesh.format,
      bounds: buildStats({ ...mesh, positions: result.positions, indices: result.indices }).bounds,
    };
    
    // Post-processing: Taubin smoothing with volume preservation
    const smoothedMesh = taubinSmoothing(simplifiedMesh, {
      iterations: 3,
      lambda: 0.5,
      mu: -0.53,
      preserveVolume: true,
      featureAngleThreshold: 30 * Math.PI / 180,
      fixedVertices: new Set()
    });
    
    const reducedMesh: MeshData = {
      positions: smoothedMesh.positions,
      indices: smoothedMesh.indices,
      format: mesh.format,
      bounds: buildStats(smoothedMesh).bounds,
    };
    
    const reduced = buildStats(reducedMesh);
    post({ type: 'progress', phase: 'validating', progress: 0.9, message: 'Validando a malha reduzida…', stats: reduced });
    
    const stl = exportBinaryStl(reducedMesh);
    if (!stl.valid) throw new Error(stl.error ?? 'Falha durante a geração do STL.');
    
    post({ type: 'progress', phase: 'exporting', progress: 0.98, message: 'Gerando STL binário validado…' });
    
    const complete: WorkerSuccess = {
      type: 'complete',
      original,
      reduced,
      stl,
      positions: smoothedMesh.positions,
      indices: smoothedMesh.indices,
      warnings: [...result.warnings, ...(original.degenerateTriangles ? ['Faces degeneradas foram descartadas durante a importação.'] : [])],
      format: mesh.format,
    };
    post(complete, [smoothedMesh.positions.buffer, smoothedMesh.indices.buffer, stl.buffer]);
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