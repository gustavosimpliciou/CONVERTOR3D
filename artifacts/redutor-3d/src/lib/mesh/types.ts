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
  /** Atributos opcionais preservados ao longo da decimação (quando o formato traz). */
  uvs?: Float32Array;
  colors?: Float32Array;
  materialIds?: Uint32Array;
  skinWeights?: Float32Array;
  skinJoints?: Uint16Array;
}

export interface MeshStats {
  vertices: number;
  triangles: number;
  bounds: Bounds;
  finite: boolean;
  degenerateTriangles: number;
}

export type Quality = 'low' | 'medium' | 'high' | 'ultra';

/** Perfil de redução (fluxo COMPRESSÃO 3D): quality = fidelidade máxima. */
export type ReductionProfile = 'quality' | 'balanced' | 'aggressive' | 'maximum';

/** Modo de definição do alvo — paridade com ferramentas profissionais (rigbake). */
export type TargetMode = 'percent' | 'exact' | 'device' | 'smart';
export type SmartLevel = 'quality' | 'balanced' | 'aggressive';
export type DevicePreset = 'background' | 'held' | 'mobile' | 'desktop' | 'hero';

export interface TriangleBudget {
  mode: TargetMode;
  /** percent: fração a MANTER (0..100). Ex.: 50 = mantém metade. */
  percent?: number;
  exactTriangles?: number;
  device?: DevicePreset;
  smartLevel?: SmartLevel;
}

/** Limites configuráveis (MAX_*): tetos de erro por operação e estágio. */
export interface ReductionLimits {
  maxMeanError?: number;
  maxMaxError?: number;
  maxNormalError?: number;
  maxCurvatureError?: number;
  maxSilhouetteError?: number;
  maxVolumeError?: number;
  maxDriftNormal?: number;
}

export interface SimplifyOptions {
  targetTriangles: number;
  quality: Quality;
  preserveBorders: boolean;
  preserveSilhouette: boolean;
  protectDetails: boolean;
  timeBudgetMs?: number;
  onCheckpoint?: (activeTriangles: number) => boolean;
  /** Quando presente, governa pisos e tetos (legado `quality` vira fallback). */
  profile?: ReductionProfile;
  limits?: ReductionLimits;
  /** Modo profissional do alvo (para relatório / rollback inteligente). */
  targetMode?: TargetMode;
  smartLevel?: SmartLevel;
  /** Orçamento de erro geométrico como fração da diagonal (ex.: 0.002 = 0,2%). */
  errorBudget?: number;
  /** Piso mínimo de triângulos por componente conectado (peças pequenas não somem). */
  minComponentTriangles?: number;
  /** Preservação de atributos (quando o formato de origem traz). */
  preserveUV?: boolean;
  preserveMaterials?: boolean;
  preserveColors?: boolean;
  preserveSkinning?: boolean;
}

export interface HealingLogEntry {
  kind: string;
  center: [number, number, number];
  size: number;
  facesAdded: number;
  errorBefore: number;
  errorAfter: number;
  timeMs: number;
  rolledBack: boolean;
  reason?: string;
}

export interface HealingSummary {
  defectsFound: number;
  defectsRepaired: number;
  defectsRolledBack: number;
  facesAdded: number;
  timeMs: number;
  log: HealingLogEntry[];
}

/** Relatório de qualidade da redução (números reais do arquivo produzido). */
export interface SimplifyReport {
  engine?: 'meshoptimizer' | 'adaptive-qem';
  stages: number;
  commits: number;
  meanError: number;
  maxError: number;
  rmsError: number;
  silhouetteError: number;
  normalError: number;
  curvatureError: number;
  volumeDeltaPercent: number;
  areaDeltaPercent: number;
  boundaryOriginal: number;
  boundaryFinal: number;
  nonManifoldEdges: number;
  degenerateTriangles: number;
  stoppedReason: 'target' | 'quality' | 'time' | 'stall';
  escalations: number;
  effectiveProfile?: ReductionProfile;
  healing: HealingSummary;
  /** Extensões profissionais (rigbake parity). */
  hausdorffApprox?: number;
  components?: number;
  componentFloorsHit?: number;
  errorBudget?: number;
  targetTooAggressive?: boolean;
  safeTriangleSuggestion?: number;
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
  /** Desvio por vértice (fração da diagonal) para heatmap verde→amarelo→vermelho. */
  deviation?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  materialIds?: Uint32Array;
  validation: {
    watertight: boolean;
    boundaryLoops: number;
    nonManifoldEdges: number;
    volumeDeltaPercent: number;
    boundsDeltaPercent: number;
    qualityAccepted: boolean;
  };
  report: SimplifyReport;
}

export interface BinaryStlResult {
  buffer: ArrayBuffer;
  triangles: number;
  bounds: Bounds;
  valid: boolean;
  error?: string;
}

export interface ImportRequest {
  type: 'import';
  buffer: ArrayBuffer;
  fileName: string;
}

export interface ImportTopology {
  boundaryLoops: number;
  nonManifoldEdges: number;
  components: number;
  degenerateTriangles: number;
  watertight: boolean;
  volume: number;
}

/** Versão do protocolo worker↔UI. UI rejeita respostas com protocolo diferente. */
export const MESH_PROTOCOL = 8;

export interface ImportSuccess {
  type: 'complete';
  job: 'import';
  protocol: number;
  positions: Float32Array;
  indices: Uint32Array;
  stats: MeshStats;
  formatLabel: string;
  format: MeshFormat;
  topology: ImportTopology;
  quirks: string[];
  elapsedMs: number;
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
  profile?: ReductionProfile;
  limits?: ReductionLimits;
  targetMode?: TargetMode;
  smartLevel?: SmartLevel;
  errorBudget?: number;
  minComponentTriangles?: number;
  preserveUV?: boolean;
  preserveMaterials?: boolean;
  preserveColors?: boolean;
  preserveSkinning?: boolean;
}

export type WorkerProgressPhase =
  | 'loading'
  | 'analyzing'
  | 'simplifying'
  | 'validating'
  | 'exporting';

export type ConversionStage =
  | 'ANALISANDO'
  | 'IDENTIFICANDO_FEATURES'
  | 'OTIMIZANDO'
  | 'VALIDANDO'
  | 'FINALIZANDO';

export interface WorkerProgress {
  type: 'progress';
  phase: WorkerProgressPhase;
  progress: number;
  message: string;
  stats?: MeshStats;
  elapsedMs?: number;
  originalTriangles?: number;
  targetTriangles?: number;
  /** Triângulos no estado atual (para % de redução em tempo real). */
  currentTriangles?: number;
  /** Etapa do pipeline (§55): ANALISANDO → IDENTIFICANDO FEATURES → OTIMIZANDO → VALIDANDO → FINALIZANDO. */
  stage?: ConversionStage;
  /** Tamanho original do arquivo em bytes. */
  originalBytes?: number;
}

export interface WorkerSuccess {
  type: 'complete';
  protocol: number;
  original: MeshStats;
  reduced: MeshStats;
  stl: BinaryStlResult;
  positions: Float32Array;
  indices: Uint32Array;
  deviation?: Float32Array;
  uvs?: Float32Array;
  colors?: Float32Array;
  materialIds?: Uint32Array;
  warnings: string[];
  validation: SimplifyResult['validation'];
  report: SimplifyReport;
  format: MeshFormat;
}

export interface WorkerFailure {
  type: 'error';
  message: string;
  technical?: string;
  /** ZERO_REDUCTION = otimização não avançou (upload continua válido). */
  code?: 'ZERO_REDUCTION' | 'UNREADABLE';
}

// ---------------------------------------------------------------------------
// MODO 1 — COMPRESSOR LOSSLESS (fluxo principal; não toca na malha)
// ---------------------------------------------------------------------------

export type CompressLevel = 'fast' | 'balanced' | 'max';

export interface AnalyzeRequest {
  type: 'analyze';
  buffer: ArrayBuffer;
  fileName: string;
}

export interface CompressRequest {
  type: 'compress';
  buffer: ArrayBuffer;
  fileName: string;
  level: CompressLevel;
}

export interface AnalyzeSuccess {
  type: 'complete';
  job: 'analyze';
  analysis: CompressAnalysis;
  elapsedMs: number;
}

export interface DecompressPackRequest {
  type: 'decompress-pack';
  buffer: ArrayBuffer;
  fileName: string;
}

export interface OptimizeRequest {
  type: 'optimize';
  buffer: ArrayBuffer;
  fileName: string;
}

export interface OptimizeBenchmarkEntry {
  id: string;
  label: string;
  bytes: number;
  ratio: number;
  valid: boolean;
  tier: 'A' | 'B';
}

export interface OptimizeSuccess {
  type: 'complete';
  job: 'optimize';
  /** STL/OBJ final válido, mesma extensão do original. */
  stl: ArrayBuffer;
  fileName: string;
  /** .gz secundário (arquivamento universal). */
  gzip: ArrayBuffer;
  gzipFileName: string;
  method: string;
  methodLabel: string;
  tier: 'A' | 'B';
  format: string;
  originalBytes: number;
  deliveredBytes: number;
  ratio: number;
  faces: number;
  validation: 'LOSSLESS PASS' | 'GEOMETRY PASS' | 'LOSSLESS FAIL';
  checks: Record<string, boolean>;
  warnings: string[];
  benchmark: OptimizeBenchmarkEntry[];
  meanError: number;
  maxError: number;
  volumeDeltaPercent: number;
  boundaryOriginal: number;
  boundaryFinal: number;
  elapsedMs: number;
}

export type CompressorJob = 'compress' | 'decompress';

export interface CompressorProgress {
  type: 'progress';
  job: CompressorJob;
  phase: 'analyzing' | 'compressing' | 'validating' | 'done';
  progress: number;
  message: string;
  stage?: ConversionStage;
  elapsedMs?: number;
  originalBytes?: number;
  originalTriangles?: number;
  format?: string;
}

export interface CompressAnalysis {
  format: string;
  confidence: string;
  originalBytes: number;
  originalSha256: string;
  faces: number;
  entropyBitsPerByte: number;
  suggestedLevel: CompressLevel;
  notes: string[];
}

export interface CompressorSuccess {
  type: 'complete';
  job: CompressorJob;
  analysis: CompressAnalysis;
  /** .3dpack (container inteligente). */
  pack: ArrayBuffer;
  packFileName: string;
  /** .gz universal (gzip sobre os bytes originais). */
  gzip: ArrayBuffer;
  gzipFileName: string;
  /** Original reconstruído por round-trip interno (prova visual/download). */
  rebuilt: ArrayBuffer;
  method: string;
  transform: string;
  tier: 'A' | 'B';
  originalBytes: number;
  packBytes: number;
  gzipBytes: number;
  ratioPack: number;
  ratioGzip: number;
  faces: number;
  validation: 'LOSSLESS PASS' | 'LOSSLESS FAIL';
  warnings: string[];
  elapsedMs: number;
}

export interface DecompressSuccess {
  type: 'complete';
  job: 'decompress';
  bytes: ArrayBuffer;
  fileName: string;
  format: string;
  faces: number;
  validation: 'LOSSLESS PASS' | 'LOSSLESS FAIL';
  elapsedMs: number;
}

export interface CompressorFailure {
  type: 'error';
  job: CompressorJob;
  message: string;
  technical?: string;
}
