export type MeshFormat = 'STL' | 'OBJ' | 'PLY' | 'OFF' | 'GLB' | 'GLTF' | 'FBX' | 'DAE';

export interface Bounds { min: [number, number, number]; max: [number, number, number]; size: [number, number, number]; }

export interface MeshData { positions: Float32Array; indices: Uint32Array; format: MeshFormat; bounds: Bounds; }

export type MeshSeverity = 'ok' | 'info' | 'warning' | 'error';

export interface MeshIntegrity {
  components: number;
  openEdges: number;
  nonManifoldEdges: number;
  duplicateFaces: number;
  duplicateVertices: number;
  degenerateTriangles: number;
  invalidNormals: number;
  surfaceArea: number;
  signedVolume: number;
}

export interface MeshStats extends MeshIntegrity { vertices: number; triangles: number; bounds: Bounds; finite: boolean; }

export interface MeshComparison {
  boundsDelta: number;
  areaRatio: number;
  volumeRatio: number;
  approximateError: number;
  newOpenEdges: number;
  newNonManifoldEdges: number;
  newDegenerates: number;
  severity: MeshSeverity;
}

export type Quality = 'low' | 'medium' | 'high' | 'ultra';
export interface SimplifyOptions { targetTriangles: number; quality: Quality; preserveBorders: boolean; preserveSilhouette: boolean; protectDetails: boolean; deadlineMs?: number; }
export interface SimplifyResult { positions: Float32Array; indices: Uint32Array; triangles: number; vertices: number; reductionPercent: number; warnings: string[]; }
export interface BinaryStlResult { buffer: ArrayBuffer; triangles: number; bounds: Bounds; valid: boolean; error?: string; }
export interface WorkerRequest { type: 'process'; buffer: ArrayBuffer; fileName: string; targetTriangles: number; quality: Quality; preserveBorders: boolean; preserveSilhouette: boolean; protectDetails: boolean; }
export type WorkerProgressPhase = 'loading' | 'analyzing' | 'simplifying' | 'validating' | 'exporting';
export interface WorkerProgress { type: 'progress'; phase: WorkerProgressPhase; progress: number; message: string; stats?: MeshStats; }
export interface SimplificationAttempt { target: number; triangles: number; accepted: boolean; reason?: string; }
export interface WorkerSuccess { type: 'complete'; original: MeshStats; reduced: MeshStats; comparison: MeshComparison; attempts: SimplificationAttempt[]; targetReached: boolean; stl: BinaryStlResult; positions: Float32Array; indices: Uint32Array; warnings: string[]; format: MeshFormat; }
export interface WorkerFailure { type: 'error'; message: string; technical?: string; }
