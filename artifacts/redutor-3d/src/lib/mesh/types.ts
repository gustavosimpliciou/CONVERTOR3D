export type MeshFormat = 'STL' | 'OBJ' | 'PLY' | 'OFF' | 'GLB' | 'GLTF';

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
  components?: number;
  hasSilhouette?: boolean;
}

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

export interface SimplifyOptions {
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  distributeFacesProportionally: boolean;
}

export interface SimplifyResult {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
  vertices: number;
  reductionPercent: number;
  warnings: string[];
  perComponent?: { triangles: number; vertices: number }[];
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
  distributeFacesProportionally: boolean;
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
}

export interface WorkerSuccess {
  type: 'complete';
  original: MeshStats;
  reduced: MeshStats;
  stl: BinaryStlResult;
  positions: Float32Array;
  indices: Uint32Array;
  warnings: string[];
  format: MeshFormat;
  perComponent?: { triangles: number; vertices: number }[];
}

export interface WorkerFailure {
  type: 'error';
  message: string;
  technical?: string;
}

export interface ComponentDistribution {
  componentName: string;
  originalTriangles: number;
  targetTriangles: number;
  reductionPercent: number;
}