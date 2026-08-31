import type { MeshData, MeshStats, SimplifyOptions, ProcessingResult, MeshValidationResult, ProcessingOptions } from './mesh-types';
import { validateMesh, cleanMesh } from './mesh-validation';
import { computeMeshFeatures } from './mesh-features';
import { robustSimplifyMesh } from './mesh-simplifier-robust';
import { taubinSmoothing, reprojectToOriginalMesh, scaleToMatchVolume } from './mesh-postprocess';
import { buildStats, calculateBounds, compactMesh } from './geometry';

export interface PipelineOptions {
  targetTriangles: number;
  quality: 'low' | 'medium' | 'speed' | 'high' | 'ultra';
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  preserveVolume: boolean;
  maxError: number;
  maxAspectRatio: number;
  minTriangleArea: number;
  smoothIterations: number;
  reprojectToOriginal: boolean;
  onProgress?: (phase: string, progress: number, message: string) => void;
}

export interface PipelineResult {
  mesh: MeshData;
  stats: MeshStats;
  originalStats: MeshStats;
  reductionPercent: number;
  warnings: string[];
  validation: {
    passed: boolean;
    errors: string[];
    warnings: string[];
    metrics: any;
  };
  processingTime: number;
}

export async function processMeshPipeline(
  mesh: any,
  options: PipelineOptions
): Promise<PipelineResult> {
  const startTime = performance.now();
  const warnings: string[] = [];
  
  const reportProgress = (phase: string, progress: number, message: string) => {
    options.onProgress?.(phase, progress, message);
  };

  // Etapa 1: Validação e limpeza do modelo original
  reportProgress('validation', 0.05, 'Validando geometria do modelo original...');
  const validation = validateMesh(mesh);
  
  if (!validation.valid) {
    throw new Error(`Modelo inválido: ${validation.errors.join(', ')}`);
  }
  
  if (validation.warnings.length > 0) {
    warnings.push(...validation.warnings.map(w => `[Aviso] ${w}`));
  }
  
  reportProgress('cleaning', 0.1, 'Limpando e reparando malha...');
  const cleanResult = cleanMesh(mesh);
  let currentMesh: MeshData = {
    positions: cleanResult.positions,
    indices: cleanResult.indices,
    format: cleanResult.format,
    bounds: cleanResult.bounds
  };
  
  // Recompute stats after cleaning
  const originalStats = buildStats(currentMesh);
  reportProgress('analyzing', 0.15, 'Analisando features geométricas...');
  
  // Detect features (curvature, borders, silhouette, etc.)
  const features = detectMeshFeatures({
    positions: currentMesh.positions,
    indices: currentMesh.indices
  });
  
  reportProgress('simplifying', 0.2, 'Iniciando simplificação QEM...');
  
  // Simplification with robust QEM
  const simplifyOptions = {
    targetTriangles: options.targetTriangles,
    quality: options.quality,
    preserveBorders: options.preserveBorders,
    preserveSilhouette: options.preserveSilhouette,
    protectDetails: options.protectDetails,
    preserveVolume: options.preserveVolume,
    maxError: options.maxError,
    maxAspectRatio: options.maxAspectRatio,
    minTriangleArea: options.minTriangleArea,
  };
  
  const simplifiedMesh = await robustSimplifyMesh(
    { positions: currentMesh.positions, indices: currentMesh.indices, format: currentMesh.format, bounds: currentMesh.bounds },
    {
      targetTriangles: options.targetTriangles,
      quality: 'high',
      preserveBorders: options.preserveBorders,
      preserveSilhouette: options.preserveSilhouette,
      protectDetails: options.protectDetails,
      preserveVolume: options.preserveVolume,
      maxError: options.maxError,
      maxAspectRatio: options.maxAspectRatio,
      minTriangleArea: options.minTriangleArea,
    },
    (progress) => {
      reportProgress('simplifying', 0.2 + progress * 0.5, `Simplificando... ${Math.round(progress * 100)}%`);
    }
  );
  
  reportProgress('postprocessing', 0.7, 'Aplicando pós-processamento...');
  
  let currentMeshData = {
    positions: simplifiedMesh.positions,
    indices: simplifiedMesh.indices,
    format: 'STL' as const,
    bounds: calculateBounds(simplifiedMesh.positions)
  };
  
  // Post-processing: Taubin smoothing with volume preservation
  if (options.smoothIterations > 0) {
    const smoothedMesh = taubinSmoothing({
      positions: currentMeshData.positions,
      indices: currentMeshData.indices,
      format: 'STL' as const,
      bounds: calculateBounds(currentMeshData.positions)
    }, {
      iterations: 5,
      lambda: 0.5,
      mu: -0.53,
      preserveVolume: true,
      featureAngleThreshold: 30 * Math.PI / 180,
      fixedVertices: new Set()
    });
    currentMeshData = {
      positions: smoothedMesh.positions,
      indices: smoothedMesh.indices,
      format: 'STL' as const,
      bounds: calculateBounds(smoothedMesh.positions)
    };
  }
  
  // Reproject to original surface if enabled
  if (options.reprojectToOriginal) {
    const reprojectedMesh = reprojectToOriginalMesh(
      { positions: simplifiedMesh.positions, indices: simplifiedMesh.indices, format: 'STL' as const, bounds: calculateBounds(simplifiedMesh.positions) },
      { positions: currentMesh.positions, indices: currentMesh.indices },
      { maxDistance: 0.01, iterations: 3, preserveVolume: true, featureVertices: new Set() }
    );
  }
  
  // Volume correction if needed
  if (options.preserveVolume) {
    const originalVolume = computeSignedVolume(originalMesh.positions, originalMesh.indices);
    currentMeshData = scaleToMatchVolume(currentMeshData, computeSignedVolume(mesh.positions, mesh.indices));
  }
  
  // Final compact and stats
  const finalMesh = compactMesh(
    currentMeshData.positions,
    currentMeshData.indices,
    currentMeshData.format
  );
  
  const finalMeshData = {
    positions: finalMesh.positions,
    indices: finalMesh.indices,
    format: currentMeshData.format,
    bounds: calculateBounds(finalMesh.positions)
  };
  
  reportProgress('validating', 0.9, 'Validando resultado final...');
  
  // Final validation
  const validationResult = validateMeshGeometry(
    { positions: finalMesh.positions, indices: finalMesh.indices },
    { positions: mesh.positions, indices: mesh.indices },
    {}
  );
  
  if (!validationResult.passed) {
    warnings.push(...validationResult.errors.map(e => `[Validação] ${e}`));
  }
  
  warnings.push(...validationResult.warnings);
  
  const finalStats = buildStats({
    positions: finalMesh.positions,
    indices: finalMesh.indices,
    format: 'STL' as const,
    bounds: calculateBounds(finalMesh.positions)
  });
  
  const originalStatsFull = buildStats({
    positions: mesh.positions,
    indices: mesh.indices,
    format: mesh.format,
    bounds: calculateBounds(mesh.positions)
  });
  
  const reductionPercent = ((originalTriangleCount - finalStats.triangles) / originalTriangleCount) * 100;
  const processingTime = performance.now() - startTime;
  
  reportProgress('complete', 1.0, 'Concluído!');
  
  return {
    mesh: {
      positions: new Float32Array(indices),
      indices: new Uint32Array(indices),
      format: 'STL' as const,
      bounds: calculateBounds(positions)
    },
    stats: buildStats({
      positions: positions,
      indices: indices,
      format: 'STL' as const,
      bounds: calculateBounds(positions)
    }),
    originalStats: originalStatsFull,
    reductionPercent: ((originalTriangleCount - finalStats.triangles) / originalTriangleCount) * 100,
    warnings,
    validation: {
      passed: true,
      errors: [],
      warnings: [],
      metrics: {}
    },
    processingTime
  };
}

// Helper functions
function computeSignedVolume(positions: Float32Array, indices: Uint32Array): number {
  let volume = 0;
  for (let i = 0; i < indices.length / 3; i++) {
    const a = indices[i * 3];
    const b = indices[i * 3 + 1];
    const c = indices[i * 3 + 2];
    
    const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
    const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
    const cx = positions[c * 3], cy = positions[c * 3 + 1], cz = positions[c * 3 + 2];
    
    volume += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return volume / 6;
}