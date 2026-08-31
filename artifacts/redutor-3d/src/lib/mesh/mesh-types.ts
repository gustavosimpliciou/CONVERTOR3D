export type MeshFormat = 'STL' | 'OBJ' | 'PLY' | 'OFF' | 'GLB' | 'GLTF' | 'FBX' | 'DAE';

export interface Vec3 {
  x: number; y: number; z: number;
}

export interface Bounds {
  min: Vec3;
  max: Vec3;
  size: Vec3;
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
  hasBoundary: boolean;
  genus?: number;
  eulerCharacteristic?: number;
}

export type Quality = 'low' | 'medium' | 'speed' | 'high' | 'ultra';

export interface SimplifyOptions {
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  preserveVolume: boolean;
  maxError: number;
  maxAspectRatio: number;
  minTriangleArea: number;
  smoothIterations: number;
  reprojectToOriginal: boolean;
}

export interface SimplifyResult {
  positions: Float32Array;
  indices: Uint32Array;
  triangles: number;
  vertices: number;
  reductionPercent: number;
  warnings: string[];
  stats: MeshStats;
  hausdorffDistance?: number;
  volumeChangePercent?: number;
}

export interface BinaryStlResult {
  buffer: ArrayBuffer;
  triangles: number;
  bounds: Bounds;
  valid: boolean;
  error?: string;
}

export interface MeshValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  stats: MeshStats;
  issues: MeshIssue[];
}

export interface MeshIssue {
  type: 'duplicate_vertices' | 'degenerate_faces' | 'non_manifold' | 'open_edges' | 'holes' | 
        'duplicate_faces' | 'zero_area' | 'thin_triangles' | 'inverted_normals' | 
        'self_intersection' | 'isolated_vertices' | 'non_manifold_edges' | 'non_manifold_vertices';
  severity: 'error' | 'warning' | 'info';
  count: number;
  indices?: number[];
  description: string;
}

export interface MeshFeatures {
  boundaryVertices: Set<number>;
  boundaryEdges: Set<number>;
  silhouetteVertices: Set<number>;
  silhouetteEdges: Set<number>;
  featureVertices: Set<number>;
  featureEdges: Set<number>;
  cornerVertices: Set<number>;
  curvature: Float32Array;
  gaussianCurvature: Float32Array;
  meanCurvature: Float32Array;
  vertexImportance: Float32Array;
  boundaryLoops: number[][];
  silhouetteLoops: number[][];
}

export interface QuadricData {
  matrix: Float32Array;
  valid: boolean;
}

export interface EdgeCollapseCandidate {
  v1: number;
  v2: number;
  position: [number, number, number];
  cost: number;
  valid: boolean;
  volumeChange: number;
  silhouetteChange: number;
  quality: number;
  maxAspectRatio: number;
  minAngle: number;
  volumeChangePercent: number;
  normalDeviation: number;
}

export interface ValidationConfig {
  maxError: number;
  maxAspectRatio: number;
  minTriangleArea: number;
  minAngle: number;
  maxNormalDeviation: number;
  maxVolumeChangePercent: number;
  maxSilhouetteDeviation: number;
  maxHausdorffDistance: number;
  checkSelfIntersection: boolean;
  checkVolumePreservation: boolean;
  checkSilhouette: boolean;
}

export interface SimplificationState {
  positions: Float32Array;
  indices: Uint32Array;
  originalPositions: Float32Array;
  originalIndices: Uint32Array;
  triangles: number[][];
  originalTriangles: number[][];
  quadrics: Float32Array[];
  vertexTriangles: number[][];
  edgeMap: Map<number, number>;
  edges: number[];
  aliveVertices: Uint8Array;
  vertexTriangles: number[][];
  faceNormals: Float32Array;
  vertexNormals: Float32Array;
  originalPositions: Float32Array;
  originalNormals: Float32Array;
  bounds: Bounds;
  originalBounds: Bounds;
  originalVolume: number;
  features: MeshFeatures;
  validationConfig: ValidationConfig;
}

export interface ProcessingOptions {
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  preserveVolume: boolean;
  maxError: number;
  maxAspectRatio: number;
  minTriangleArea: number;
  smoothIterations: number;
  reprojectToOriginal: boolean;
}

export interface ProcessingResult {
  mesh: MeshData;
  stats: MeshStats;
  reductionPercent: number;
  warnings: string[];
  hausdorffDistance: number;
  volumeChangePercent: number;
  processingTime: number;
  warnings: string[];
}

export interface ValidationResult {
  passed: boolean;
  errors: string[];
  warnings: string[];
  metrics: {
    hausdorffDistance: number;
    volumeChangePercent: number;
    maxAspectRatio: number;
    minTriangleArea: number;
    minAngle: number;
    normalDeviation: number;
    volumeChangePercent: number;
    silhouetteDeviation: number;
    selfIntersections: number;
  };
}