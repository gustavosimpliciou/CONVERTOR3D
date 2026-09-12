export type MeshFormat =
  | 'STL'
  | 'OBJ'
  | 'PLY'
  | 'OFF'
  | 'GLB'
  | 'GLTF'
  | 'FBX'
  | 'DAE';

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
}

export interface MeshData {
  positions: Float32Array;
  indices: Uint32Array;
  format: MeshFormat;
  bounds: Bounds;
}

export interface MeshStats {
  vertices: number;
  triangles: number;
  bounds: Bounds;
  finite: boolean;
  degenerateTriangles: number;
}

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface SimplifyOptions {
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  timeBudgetMs?: number;
  onCheckpoint?: (activeTriangles: number) => boolean;
}

export interface SimplifyResult {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
  vertices: number;
  reductionPercent: number;
  warnings: string[];
  stoppedSafely: boolean;
  elapsedMs: number;
  validation: {
    watertight: boolean;
    boundaryLoops: number;
    nonManifoldEdges: number;
    volumeDeltaPercent: number;
    boundsDeltaPercent: number;
    qualityAccepted: boolean;
  };
}

export interface BinaryStlResult {
  buffer: ArrayBuffer;
  triangles: number;
  bounds: Bounds;
  valid: boolean;
  error?: string;
}

export interface WorkerRequest {
  type: 'process';
  buffer: ArrayBuffer;
  fileName: string;
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  timeBudgetMs?: number;
}

export type WorkerProgressPhase =
  | 'loading'
  | 'analyzing'
  | 'simplifying'
  | 'validating'
  | 'exporting';

export interface WorkerProgress {
  type: 'progress';
  phase: WorkerProgressPhase;
  progress: number;
  message: string;
  stats?: MeshStats;
  elapsedMs?: number;
  originalTriangles?: number;
  targetTriangles?: number;
}

export interface WorkerSuccess {
  type: 'complete';
  original: MeshStats;
  reduced: MeshStats;
  stl: BinaryStlResult;
  positions: Float32Array;
  indices: Uint32Array;
  warnings: string[];
  validation: SimplifyResult['validation'];
  format: MeshFormat;
}

export interface WorkerFailure {
  type: 'error';
  message: string;
  technical?: string;
}
