/**
 * FEATURE-AWARE ADAPTIVE MESH DECIMATION ENGINE
 * =============================================
 * Minimiza NUMBER_OF_FACES sujeito a:
 *   TOPOLOGY_PRESERVED, WATERTIGHT_PRESERVED, FEATURES_PRESERVED,
 *   SILHOUETTE_PRESERVED, SURFACE_ERROR < THRESHOLD, LOCAL_ERROR < THRESHOLD,
 *   VOLUME_ERROR < THRESHOLD, NO_NEW_BOUNDARIES, NO_NEW_NON_MANIFOLD,
 *   NO_SELF_INTERSECTION, NO_DEGENERATE_TRIANGLES.
 *
 * Pipeline real (não apenas visual):
 *   MODELO ORIGINAL (referência imutável)
 *     → ANÁLISE DA GEOMETRIA (complexity map)
 *     → ÁREAS SIMPLES: decimação alta | ÁREAS COMPLEXAS: análise de curvatura
 *     → FEATURE LOCK → DECIMAÇÃO ADAPTATIVA PROGRESSIVA (estágios + rollback)
 *     → VALIDAÇÃO 3D contínua → MODELO FINAL (mesma forma + menos faces)
 *
 * Correções de causa-raiz em relação ao motor anterior:
 *  1. Contagem de arestas incremental EXATA (o motor antigo apagava e
 *     recriava contagens só com as faces afetadas, corrompendo a detecção
 *     de borda e criando buracos).
 *  2. Heap com versionamento (entradas obsoletas com posições antigas
 *     causavam flips e deformações).
 *  3. Custo combinado QEM + curvatura + feature + silhueta + estrutura fina
 *     + qualidade de triângulo (antes: só QEM + variação de normal).
 *  4. SIMULATE → VALIDATE → COMMIT/REJECT por operação, com limite de
 *     deslocamento e link condition sobre vizinhança viva.
 *  5. Estágios progressivos com snapshot, rollback e quality floor; o target
 *     é meta, não autorização para deformar.
 */
import { compactMesh } from './geometry';
import { auditMesh, auditWithinTolerance } from './validation';
import { computeComplexityMap, importanceMultiplier, RegionClass, edgeKeyOf } from './complexity';
import {
  boundaryCollapseAllowed,
  buildTriangleGrid,
  directedSamplesError,
  displacementAllowed,
  linkCondition,
  queryGridClosest,
  silhouetteError,
  triangleAspect,
  validateResultTriangles,
} from './safeguards';
import type { TriangleValidationStats } from './safeguards';
import type { MeshData, ReductionProfile, SimplifyOptions, SimplifyResult } from './types';

type Quadric = [number, number, number, number, number, number, number, number, number, number];

interface HeapEntry {
  a: number;
  b: number;
  va: number;
  vb: number;
  x: number;
  y: number;
  z: number;
  cost: number;
}

class MinHeap {
  private values: HeapEntry[] = [];
  get size(): number {
    return this.values.length;
  }
  push(value: HeapEntry): void {
    this.values.push(value);
    let i = this.values.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.values[parent].cost <= value.cost) break;
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.values[i] = value;
  }
  pop(): HeapEntry | undefined {
    if (this.values.length === 0) return undefined;
    const first = this.values[0];
    const last = this.values.pop() as HeapEntry;
    if (this.values.length > 0) {
      let i = 0;
      for (;;) {
        const left = i * 2 + 1;
        if (left >= this.values.length) break;
        const right = left + 1;
        const child = right < this.values.length && this.values[right].cost < this.values[left].cost ? right : left;
        if (this.values[child].cost >= last.cost) break;
        this.values[i] = this.values[child];
        i = child;
      }
      this.values[i] = last;
    }
    return first;
  }
}

const emptyQuadric = (): Quadric => [0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

function addQuadricInPlace(target: Quadric, other: Quadric): void {
  for (let i = 0; i < 10; i += 1) target[i] += other[i];
}

function planeQuadric(a: number, b: number, c: number, d: number, weight: number): Quadric {
  return [
    a * a * weight, a * b * weight, a * c * weight, a * d * weight,
    b * b * weight, b * c * weight, b * d * weight,
    c * c * weight, c * d * weight, d * d * weight,
  ];
}

function evaluateQuadric(q: Quadric, x: number, y: number, z: number): number {
  return (
    q[0] * x * x + 2 * q[1] * x * y + 2 * q[2] * x * z + 2 * q[3] * x +
    q[4] * y * y + 2 * q[5] * y * z + 2 * q[6] * y +
    q[7] * z * z + 2 * q[8] * z + q[9]
  );
}

function optimalPosition(q: Quadric, ax: number, ay: number, az: number, bx: number, by: number, bz: number): [number, number, number] {
  const det =
    q[0] * (q[4] * q[7] - q[5] * q[5]) -
    q[1] * (q[1] * q[7] - q[5] * q[2]) +
    q[2] * (q[1] * q[5] - q[4] * q[2]);
  if (Math.abs(det) > 1e-18) {
    const x =
      -(q[3] * (q[4] * q[7] - q[5] * q[5]) -
        q[1] * (q[6] * q[7] - q[5] * q[8]) +
        q[2] * (q[6] * q[5] - q[4] * q[8])) / det;
    const y =
      -(q[0] * (q[6] * q[7] - q[5] * q[8]) -
        q[3] * (q[1] * q[7] - q[5] * q[2]) +
        q[2] * (q[1] * q[8] - q[6] * q[2])) / det;
    const z =
      -(q[0] * (q[4] * q[8] - q[6] * q[5]) -
        q[1] * (q[1] * q[8] - q[6] * q[2]) +
        q[3] * (q[1] * q[5] - q[4] * q[2])) / det;
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) return [x, y, z];
  }
  return [(ax + bx) / 2, (ay + by) / 2, (az + bz) / 2];
}

interface EngineParams {
  floorMean: number;
  floorMax: number;
  volMax: number;
  bndMax: number;
  /** Teto normal (fração da diagonal) — deriva acumulada e teto por plano. */
  driftN: number;
  lockGate: number;
  /** Tetos de estágio (Infinity = checagem desligada, comportamento legado). */
  silhouetteMax: number;
  normalMax: number;
  curvatureMax: number;
  dotCrit: number;
  dotMicro: number;
  aspectCrit: number;
  aspectMicro: number;
}

/**
 * Perfis QUALITY / BALANCED / AGGRESSIVE + limites configuráveis (MAX_*).
 * Sem `profile`, reproduz exatamente o comportamento legado por `quality`
 * (testes de regressão existentes dependem disso).
 */
function paramsFor(options: SimplifyOptions): EngineParams {
  const q = options.quality;
  const legacyDrift = q === 'ultra' ? 0.004 : q === 'high' ? 0.008 : q === 'medium' ? 0.015 : 0.03;
  const legacyLock = q === 'ultra' ? 1e-4 : q === 'high' ? 4e-4 : q === 'medium' ? 1.5e-3 : 5e-3;
  const legacyFloor = q === 'ultra'
    ? { floorMean: 0.0012, floorMax: 0.012, volMax: 1.2, bndMax: 0.6 }
    : q === 'high'
      ? { floorMean: 0.0025, floorMax: 0.025, volMax: 2.5, bndMax: 1.2 }
      : q === 'medium'
        ? { floorMean: 0.0045, floorMax: 0.045, volMax: 4, bndMax: 2 }
        : { floorMean: 0.008, floorMax: 0.08, volMax: 6, bndMax: 3 };
  let base: EngineParams;
  if (options.profile === 'quality') {
    base = { ...legacyFloor, floorMean: 0.0012, floorMax: 0.012, volMax: 1.2, bndMax: 0.6, driftN: 0.004, lockGate: 1e-4, silhouetteMax: 0.012, normalMax: 0.02, curvatureMax: 0.03, dotCrit: 0.75, dotMicro: 0.6, aspectCrit: 4, aspectMicro: 6 };
  } else if (options.profile === 'balanced') {
    base = { ...legacyFloor, floorMean: 0.0025, floorMax: 0.025, volMax: 2.5, bndMax: 1.2, driftN: 0.008, lockGate: 4e-4, silhouetteMax: 0.02, normalMax: 0.035, curvatureMax: 0.05, dotCrit: 0.75, dotMicro: 0.6, aspectCrit: 4, aspectMicro: 6 };
  } else if (options.profile === 'aggressive') {
    base = { ...legacyFloor, floorMean: 0.006, floorMax: 0.06, volMax: 6, bndMax: 3, driftN: 0.02, lockGate: 2e-3, silhouetteMax: 0.045, normalMax: 0.06, curvatureMax: 0.09, dotCrit: 0.7, dotMicro: 0.55, aspectCrit: 6, aspectMicro: 8 };
  } else if (options.profile === 'maximum') {
    // MAXIMUM: busca o menor tamanho sem destruir a identidade. Pisos de
    // erro maiores, mas guardrails topológicos NUNCA relaxam (sem buracos,
    // sem flips, sem non-manifold — esses vetos são absolutos).
    base = { ...legacyFloor, floorMean: 0.012, floorMax: 0.1, volMax: 9, bndMax: 4.5, driftN: 0.035, lockGate: 6e-3, silhouetteMax: 0.07, normalMax: 0.09, curvatureMax: 0.12, dotCrit: 0.65, dotMicro: 0.5, aspectCrit: 8, aspectMicro: 10 };
  } else {
    base = { ...legacyFloor, driftN: legacyDrift, lockGate: legacyLock, silhouetteMax: Infinity, normalMax: Infinity, curvatureMax: Infinity, dotCrit: 0.75, dotMicro: 0.6, aspectCrit: 4, aspectMicro: 6 };
  }
  const limits = options.limits ?? {};
  if (limits.maxMeanError !== undefined) base.floorMean = limits.maxMeanError;
  if (limits.maxMaxError !== undefined) base.floorMax = limits.maxMaxError;
  if (limits.maxVolumeError !== undefined) base.volMax = limits.maxVolumeError;
  if (limits.maxNormalError !== undefined) base.normalMax = limits.maxNormalError;
  if (limits.maxCurvatureError !== undefined) base.curvatureMax = limits.maxCurvatureError;
  if (limits.maxSilhouetteError !== undefined) base.silhouetteMax = limits.maxSilhouetteError;
  if (limits.maxDriftNormal !== undefined) base.driftN = limits.maxDriftNormal;
  return base;
}

function stageTargets(from: number, to: number): number[] {
  const targets: number[] = [];
  let current = from;
  let guard = 0;
  while (current > to && guard < 10) {
    guard += 1;
    // Reduz no máximo ~30% por estágio (decimação progressiva).
    const next = Math.max(to, Math.floor(current * 0.7));
    if (next >= current) break;
    targets.push(next);
    current = next;
    if (targets.length >= 8) break;
  }
  if (targets.length === 0 || targets[targets.length - 1] !== to) targets.push(to);
  return targets;
}

function removeFromList(list: number[], value: number): void {
  const index = list.indexOf(value);
  if (index < 0) return;
  list[index] = list[list.length - 1];
  list.pop();
}

export function simplifyMesh(mesh: MeshData, options: SimplifyOptions, onProgress?: (progress: number) => void): SimplifyResult {
  const startedAt = performance.now();
  const timeBudget = options.timeBudgetMs ?? 55_000;
  const deadline = startedAt + timeBudget;
  const originalTriangles = mesh.indices.length / 3;
  const target = Math.max(4, Math.floor(options.targetTriangles));
  const referenceAudit = auditMesh(mesh);
  let P = paramsFor(options);
  /** Perfil efetivo (sobe na cascata quando o estágio trava). */
  let curProfile: ReductionProfile | undefined = options.profile;
  const timedOut = (): boolean => performance.now() >= deadline;
  // Métricas do último estágio validado (para o relatório final).
  const lastMetrics = { mean: 0, max: 0, silhouette: 0, normal: 0, curvature: 0 };
  let stoppedReason: 'target' | 'quality' | 'time' | 'stall' = 'target';
  let escalations = 0;
  let stagesCompleted = 0;
  let commits = 0;

  const finishWith = (
    positions: Float32Array,
    indices: Uint32Array,
    warnings: string[],
    stoppedSafely: boolean,
  ): SimplifyResult => {
    const outTriangles = indices.length / 3;
    // Auditoria RELATIVA à referência: defeitos pré-existentes (ex. winding
    // misto no arquivo de origem) não invalidam uma redução que não criou
    // nenhum defeito novo. Vale FINAL <= ORIGINAL.
    const finalAudit = auditMesh({ positions, indices, format: mesh.format, bounds: mesh.bounds }, referenceAudit);
    const safe = finalAudit.valid && auditWithinTolerance(finalAudit, referenceAudit);
    const output = safe ? { positions, indices } : { positions: mesh.positions, indices: mesh.indices };
    const outputAudit = safe ? finalAudit : referenceAudit;
    const allWarnings = [
      ...warnings,
      ...finalAudit.reasons,
      ...(!safe ? ['A tolerância geométrica foi excedida; o melhor estado seguro foi mantido.'] : []),
    ];
    const volumeDeltaPercent =
      (Math.abs(Math.abs(outputAudit.volume) - Math.abs(referenceAudit.volume)) /
        Math.max(Math.abs(referenceAudit.volume), Math.max(...referenceAudit.bounds.size, 1e-9) ** 3 * 1e-6)) * 100;
    const boundsDeltaPercent =
      (Math.max(
        ...outputAudit.bounds.min.map((v, i) => Math.abs(v - referenceAudit.bounds.min[i])),
        ...outputAudit.bounds.max.map((v, i) => Math.abs(v - referenceAudit.bounds.max[i])),
      ) /
        Math.max(...referenceAudit.bounds.size, 1e-9)) * 100;
    const areaDeltaPercent =
      (Math.abs(outputAudit.surfaceArea - referenceAudit.surfaceArea) /
        Math.max(referenceAudit.surfaceArea, 1e-24)) * 100;
    return {
      positions: output.positions,
      indices: output.indices,
      triangles: output.indices.length / 3,
      vertices: output.positions.length / 3,
      reductionPercent: ((originalTriangles - outTriangles) / Math.max(1, originalTriangles)) * 100,
      warnings: allWarnings,
      stoppedSafely: stoppedSafely || !safe,
      elapsedMs: performance.now() - startedAt,
      validation: {
        watertight: outputAudit.boundaryLoops === 0,
        boundaryLoops: outputAudit.boundaryLoops,
        nonManifoldEdges: outputAudit.nonManifoldEdges,
        volumeDeltaPercent,
        boundsDeltaPercent,
        qualityAccepted: outputAudit.valid,
      },
      report: {
        stages: stagesCompleted,
        commits,
        meanError: lastMetrics.mean,
        maxError: lastMetrics.max,
        silhouetteError: lastMetrics.silhouette,
        normalError: lastMetrics.normal,
        curvatureError: lastMetrics.curvature,
        volumeDeltaPercent,
        areaDeltaPercent,
        boundaryOriginal: referenceAudit.boundaryLoops,
        boundaryFinal: outputAudit.boundaryLoops,
        nonManifoldEdges: outputAudit.nonManifoldEdges,
        degenerateTriangles: outputAudit.degenerateTriangles,
        stoppedReason,
        escalations,
        effectiveProfile: curProfile ?? undefined,
      },
    };
  };

  if (target >= originalTriangles) {
    return finishWith(mesh.positions, mesh.indices, [...referenceAudit.reasons], false);
  }

  // ------------------------------------------------------------------
  // REFERÊNCIA ORIGINAL IMUTÁVEL (nunca modificada durante a conversão)
  // ------------------------------------------------------------------
  const vertexCount = mesh.positions.length / 3;
  const pos = new Float64Array(mesh.positions.length);
  for (let i = 0; i < mesh.positions.length; i += 1) pos[i] = mesh.positions[i];
  const tri = new Int32Array(mesh.indices.length);
  for (let i = 0; i < mesh.indices.length; i += 1) tri[i] = mesh.indices[i];
  const triAlive = new Uint8Array(originalTriangles).fill(1);
  const vertAlive = new Uint8Array(vertexCount).fill(1);
  const vertVersion = new Uint32Array(vertexCount);
  const quadrics: Quadric[] = Array.from({ length: vertexCount }, emptyQuadric);
  const faceNormals = new Float64Array(originalTriangles * 3);
  const vertFaces: Array<number[]> = Array.from({ length: vertexCount }, () => []);
  const edgeCounts = new Map<string, number>();
  const edgeFaces = new Map<string, number[]>();
  const vertOnBoundary = new Uint8Array(vertexCount);

  const getVertex = (index: number): [number, number, number] => [pos[index * 3], pos[index * 3 + 1], pos[index * 3 + 2]];

  const addEdge = (a: number, b: number, face: number): void => {
    const key = edgeKeyOf(a, b);
    edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    let list = edgeFaces.get(key);
    if (!list) {
      list = [];
      edgeFaces.set(key, list);
    }
    if (!list.includes(face)) list.push(face);
  };

  const removeEdge = (a: number, b: number, face: number): void => {
    const key = edgeKeyOf(a, b);
    const count = edgeCounts.get(key);
    if (count === undefined) return;
    const list = edgeFaces.get(key);
    if (list) {
      const index = list.indexOf(face);
      if (index >= 0) {
        list[index] = list[list.length - 1];
        list.pop();
      }
    }
    if (count <= 1 || (list && list.length === 0)) {
      edgeCounts.delete(key);
      edgeFaces.delete(key);
    } else {
      edgeCounts.set(key, count - 1);
    }
  };

  for (let t = 0; t < originalTriangles; t += 1) {
    const a = tri[t * 3]; const b = tri[t * 3 + 1]; const c = tri[t * 3 + 2];
    vertFaces[a].push(t); vertFaces[b].push(t); vertFaces[c].push(t);
    const ax = pos[a * 3]; const ay = pos[a * 3 + 1]; const az = pos[a * 3 + 2];
    const bx = pos[b * 3]; const by = pos[b * 3 + 1]; const bz = pos[b * 3 + 2];
    const cx = pos[c * 3]; const cy = pos[c * 3 + 1]; const cz = pos[c * 3 + 2];
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    faceNormals[t * 3] = nx; faceNormals[t * 3 + 1] = ny; faceNormals[t * 3 + 2] = nz;
    const length = Math.hypot(nx, ny, nz);
    if (length > 1e-18) {
      const ixn = nx / length; const iyn = ny / length; const izn = nz / length;
      const d = -(ixn * ax + iyn * ay + izn * az);
      const q = planeQuadric(ixn, iyn, izn, d, 1);
      addQuadricInPlace(quadrics[a], q);
      addQuadricInPlace(quadrics[b], q);
      addQuadricInPlace(quadrics[c], q);
    }
    addEdge(a, b, t); addEdge(b, c, t); addEdge(c, a, t);
  }

  // Pesos de borda (silhueta): penalizam mover vértices de contorno.
  if (options.preserveBorders) {
    const borderWeight = options.quality === 'ultra' ? 100 : options.quality === 'high' ? 35 : options.quality === 'medium' ? 12 : 4;
    for (const [key, count] of edgeCounts) {
      if (count !== 1) continue;
      const sep = key.indexOf(':');
      const a = Number(key.slice(0, sep));
      const b = Number(key.slice(sep + 1));
      vertOnBoundary[a] = 1; vertOnBoundary[b] = 1;
      const faces = edgeFaces.get(key);
      if (!faces || faces.length === 0) continue;
      const f = faces[0];
      const nx = faceNormals[f * 3]; const ny = faceNormals[f * 3 + 1]; const nz = faceNormals[f * 3 + 2];
      const length = Math.hypot(nx, ny, nz);
      if (length < 1e-18) continue;
      const ixn = nx / length; const iyn = ny / length; const izn = nz / length;
      const ax = pos[a * 3]; const ay = pos[a * 3 + 1]; const az = pos[a * 3 + 2];
      const bx = pos[b * 3]; const by = pos[b * 3 + 1]; const bz = pos[b * 3 + 2];
      const ex = bx - ax; const ey = by - ay; const ez = bz - az;
      let px = ey * izn - ez * iyn;
      let py = ez * ixn - ex * izn;
      let pz = ex * iyn - ey * ixn;
      const pl = Math.hypot(px, py, pz);
      if (pl < 1e-18) continue;
      px /= pl; py /= pl; pz /= pl;
      const d = -(px * ax + py * ay + pz * az);
      const q = planeQuadric(px, py, pz, d, borderWeight);
      addQuadricInPlace(quadrics[a], q);
      addQuadricInPlace(quadrics[b], q);
    }
  } else {
    for (const [key, count] of edgeCounts) {
      if (count !== 1) continue;
      const sep = key.indexOf(':');
      vertOnBoundary[Number(key.slice(0, sep))] = 1;
      vertOnBoundary[Number(key.slice(sep + 1))] = 1;
    }
  }

  const mustRemainWatertight = referenceAudit.boundaryLoops === 0 && referenceAudit.boundaryEdges === 0;

  // ------------------------------------------------------------------
  // MAPA DE COMPLEXIDADE (fase IDENTIFICANDO FEATURES)
  // ------------------------------------------------------------------
  const flatTris = new Int32Array(originalTriangles * 3);
  flatTris.set(tri);
  const complexity = computeComplexityMap({
    positions: pos,
    triangles: flatTris,
    triangleCount: originalTriangles,
    vertexCount,
    faceNormals,
    vertexFaces: vertFaces,
    edgeCounts,
    edgeFaces,
    boundsSize: referenceAudit.bounds.size,
  });
  const diagonal = Math.max(complexity.diagonal, 1e-12);
  // Piso ABSOLUTO de área (2e-6): a auditoria considera degenerada qualquer
  // face com área ≤ 5e-7 (area² ≤ 1e-12, fixo). Sem este piso, malhas finas
  // (avgFaceArea pequeno) criariam faces que passam no gate relativo mas
  // reprovam na auditoria — mismatch que travava scans sem dano real.
  const minArea = Math.max(complexity.avgFaceArea * 1e-4, diagonal * diagonal * 1e-14, 2e-6);
  const regionInitial = [0, 0, 0, 0, 0];
  const regionRemoved = [0, 0, 0, 0, 0];
  // Contagem inicial de faces por classe de região (base das cotas).
  for (let t = 0; t < originalTriangles; t += 1) {
    const r0 = complexity.region[tri[t * 3]] ?? 0;
    const r1 = complexity.region[tri[t * 3 + 1]] ?? 0;
    const r2 = complexity.region[tri[t * 3 + 2]] ?? 0;
    regionInitial[Math.max(r0, r1, r2)] += 1;
  }
  const qemScale = Math.max(complexity.avgFaceArea, 1e-24);
  onProgress?.(0.02);

  // ---------------------------------------------------------------
  // CONTROLE DE ERRO LOCAL (§22-23): cada vértice sobrevivente carrega sua
  // posição e normal ORIGINAIS (referência imutável). O deslocamento
  // acumulado é decomposto em componente normal (fora da superfície — teto
  // rígido por qualidade/região) e tangencial (deslizamento sobre a
  // superfície — teto folgado). Nenhuma cadeia de colapsos pode, sozinha,
  // estourar o piso de qualidade: a deriva total é limitada por construção.
  // ---------------------------------------------------------------
  const origNormals = new Float64Array(vertexCount * 3);
  const initLocalEdge = new Float64Array(vertexCount);
  {
    const acc = new Float64Array(vertexCount * 3);
    const wgt = new Float64Array(vertexCount);
    for (let t = 0; t < originalTriangles; t += 1) {
      const a = tri[t * 3]; const b = tri[t * 3 + 1]; const c = tri[t * 3 + 2];
      const nx = faceNormals[t * 3]; const ny = faceNormals[t * 3 + 1]; const nz = faceNormals[t * 3 + 2];
      const area = Math.hypot(nx, ny, nz) / 2;
      if (!(area > 0)) continue;
      acc[a * 3] += nx; acc[a * 3 + 1] += ny; acc[a * 3 + 2] += nz;
      acc[b * 3] += nx; acc[b * 3 + 1] += ny; acc[b * 3 + 2] += nz;
      acc[c * 3] += nx; acc[c * 3 + 1] += ny; acc[c * 3 + 2] += nz;
      wgt[a] += area; wgt[b] += area; wgt[c] += area;
    }
    for (let v = 0; v < vertexCount; v += 1) {
      const l = Math.hypot(acc[v * 3], acc[v * 3 + 1], acc[v * 3 + 2]);
      if (l > 1e-24) {
        origNormals[v * 3] = acc[v * 3] / l;
        origNormals[v * 3 + 1] = acc[v * 3 + 1] / l;
        origNormals[v * 3 + 2] = acc[v * 3 + 2] / l;
      }
    }
  }
  let driftCapNormalBase = P.driftN * diagonal;

  /** Próximo perfil da cascata (null = teto atingido ou modo legado). */
  const nextProfile = (profile: ReductionProfile | undefined): ReductionProfile | null => {
    if (profile === 'quality') return 'balanced';
    if (profile === 'balanced') return 'aggressive';
    if (profile === 'aggressive') return 'maximum';
    return null;
  };

  /** Aplica novo perfil em tempo de execução (cascata, sem rebuild). */
  const applyProfile = (next: ReductionProfile): void => {
    curProfile = next;
    P = paramsFor({ ...options, profile: next });
    impQuality = impQualityFor(next);
    regionQuota = quotaFor(next);
    driftCapNormalBase = P.driftN * diagonal;
    planeMult = 1;
  };
  let profileEscalations = 0;

  const heap = new MinHeap();
  const localEdgeLength = (vertex: number): number => {
    const incident = vertFaces[vertex];
    if (!incident || incident.length === 0) return complexity.avgEdgeLength;
    const [vx, vy, vz] = getVertex(vertex);
    let sum = 0; let count = 0;
    const limit = Math.min(incident.length, 6);
    for (let k = 0; k < limit; k += 1) {
      const f = incident[k];
      const a = tri[f * 3]; const b = tri[f * 3 + 1]; const c = tri[f * 3 + 2];
      const others = a === vertex ? [b, c] : b === vertex ? [a, c] : [a, b];
      for (const o of others) {
        if (!vertAlive[o]) continue;
        sum += Math.hypot(pos[o * 3] - vx, pos[o * 3 + 1] - vy, pos[o * 3 + 2] - vz);
        count += 1;
      }
    }
    return count > 0 ? sum / count : complexity.avgEdgeLength;
  };

  // Agressividade do custo por perfil: quality protege muito, maximum
  // protege menos (mas nunca zero — features sempre custam mais).
  const impQualityFor = (profile: ReductionProfile | undefined): SimplifyOptions['quality'] =>
    !profile
      ? options.quality
      : profile === 'quality'
        ? 'ultra'
        : profile === 'balanced'
          ? 'high'
          : profile === 'aggressive'
            ? 'medium'
            : 'low';
  let impQuality = impQualityFor(curProfile);

  // Orçamento de triângulos por região (TRIANGLE BUDGET): cotas de remoção
  // por classe — áreas simples financiam a redução (§11). Quando uma região
  // estoura sua cota, seus custos sobem e o orçamento migra sozinho.
  const quotaFor = (profile: ReductionProfile | undefined): number[] =>
    !profile || profile === 'quality'
      ? [1, 1, 1, 1, 1]
      : profile === 'balanced'
        ? [0.85, 0.6, 0.35, 0.12, 0.06]
        : profile === 'aggressive'
          ? [0.92, 0.72, 0.45, 0.18, 0.09]
          : [0.96, 0.8, 0.55, 0.25, 0.12];
  let regionQuota = quotaFor(curProfile);

  const combinedCost = (a: number, b: number, x: number, y: number, z: number): number => {
    const qa = quadrics[a]; const qb = quadrics[b];
    const qem =
      (qa[0] + qb[0]) * x * x + 2 * (qa[1] + qb[1]) * x * y + 2 * (qa[2] + qb[2]) * x * z + 2 * (qa[3] + qb[3]) * x +
      (qa[4] + qb[4]) * y * y + 2 * (qa[5] + qb[5]) * y * z + 2 * (qa[6] + qb[6]) * y +
      (qa[7] + qb[7]) * z * z + 2 * (qa[8] + qb[8]) * z + (qa[9] + qb[9]);
    const imp = Math.max(importanceMultiplier(complexity, a, impQuality), importanceMultiplier(complexity, b, impQuality));
    // Cota regional: protege classes que já pagaram além da conta.
    const cls = Math.max(complexity.region[a] ?? 0, complexity.region[b] ?? 0);
    let quotaMult = 1;
    if (curProfile && curProfile !== 'quality' && regionInitial[cls] > 0) {
      const used = regionRemoved[cls] / regionInitial[cls];
      if (used > regionQuota[cls]) quotaMult = 1 + 4 * (used - regionQuota[cls]);
    }
    const key = edgeKeyOf(a, b);
    const borderPenalty = (options.preserveSilhouette || mustRemainWatertight) && edgeCounts.get(key) === 1 ? 1000 : 1;
    return (Math.max(0, qem) / qemScale) * imp * quotaMult * borderPenalty;
  };

  const pushEdge = (a: number, b: number): void => {
    if (a === b || !vertAlive[a] || !vertAlive[b]) return;
    const key = edgeKeyOf(a, b);
    if (!edgeCounts.has(key)) return;
    const q: Quadric = [
      quadrics[a][0] + quadrics[b][0], quadrics[a][1] + quadrics[b][1], quadrics[a][2] + quadrics[b][2],
      quadrics[a][3] + quadrics[b][3], quadrics[a][4] + quadrics[b][4], quadrics[a][5] + quadrics[b][5],
      quadrics[a][6] + quadrics[b][6], quadrics[a][7] + quadrics[b][7], quadrics[a][8] + quadrics[b][8],
      quadrics[a][9] + quadrics[b][9],
    ];
    const [ox, oy, oz] = optimalPosition(q, pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]);
    heap.push({ a, b, va: vertVersion[a], vb: vertVersion[b], x: ox, y: oy, z: oz, cost: combinedCost(a, b, ox, oy, oz) });
  };

  for (let v = 0; v < vertexCount; v += 1) initLocalEdge[v] = localEdgeLength(v);

  /** Deriva acumulada: rejeita se `candidate` afastar o vértice do original. */
  const driftAllowed = (vertex: number, cx: number, cy: number, cz: number, regionFactor: number): boolean => {
    const ox = mesh.positions[vertex * 3];
    const oy = mesh.positions[vertex * 3 + 1];
    const oz = mesh.positions[vertex * 3 + 2];
    const dx = cx - ox; const dy = cy - oy; const dz = cz - oz;
    const region = complexity.region[vertex] ?? RegionClass.Plana;
    if (region === RegionClass.FeatureCritica || region === RegionClass.MicroDetalhe || complexity.locked[vertex] === 1) {
      // Em arestas vivas a normal média é diagonal à superfície real: um
      // deslizamento exato sobre a aresta teria "componente normal" enorme.
      // Aqui vale o limite isotrópico pela aresta inicial; a geometria é
      // guardada pelo flip/aspecto/link/quality-floor.
      return Math.hypot(dx, dy, dz) <= Math.max(initLocalEdge[vertex], complexity.avgEdgeLength, 1e-12) * 1.5 + driftCapNormalBase;
    }
    const nx = origNormals[vertex * 3];
    const ny = origNormals[vertex * 3 + 1];
    const nz = origNormals[vertex * 3 + 2];
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0.5)) {
      // Sem normal confiável: limita pela aresta inicial.
      return Math.hypot(dx, dy, dz) <= Math.max(initLocalEdge[vertex], 1e-12) * 1.5;
    }
    const dn = Math.abs(dx * nx + dy * ny + dz * nz) / nl;
    const tx = dx - ((dx * nx + dy * ny + dz * nz) / (nl * nl)) * nx;
    const ty = dy - ((dx * nx + dy * ny + dz * nz) / (nl * nl)) * ny;
    const tz = dz - ((dx * nx + dy * ny + dz * nz) / (nl * nl)) * nz;
    const dt = Math.hypot(tx, ty, tz);
    return (
      dn <= driftCapNormalBase * regionFactor &&
      dt <= Math.max(initLocalEdge[vertex], 1e-12) * 2.5 + driftCapNormalBase
    );
  };

  for (const key of edgeCounts.keys()) {
    const sep = key.indexOf(':');
    pushEdge(Number(key.slice(0, sep)), Number(key.slice(sep + 1)));
  }

  const neighborsOf = (vertex: number): Set<number> => {
    const result = new Set<number>();
    for (const f of vertFaces[vertex]) {
      if (!triAlive[f]) continue;
      const a = tri[f * 3]; const b = tri[f * 3 + 1]; const c = tri[f * 3 + 2];
      if (a !== vertex && vertAlive[a]) result.add(a);
      if (b !== vertex && vertAlive[b]) result.add(b);
      if (c !== vertex && vertAlive[c]) result.add(c);
    }
    return result;
  };

  /** Tenta colapsar a aresta (a,b) na posição proposta. Retorna true se COMMIT. */
  const tryCollapse = (entry: HeapEntry): boolean => {
    const { a, b } = entry;
    const dbg = (globalThis as Record<string, unknown>).__MESH_DEBUG as Record<string, number> | undefined;
    const reject = (why: string): false => {
      if (dbg) dbg[why] = (dbg[why] ?? 0) + 1;
      return false;
    };
    if (!vertAlive[a] || !vertAlive[b]) return reject('dead');
    const key = edgeKeyOf(a, b);
    if (!edgeCounts.has(key)) return reject('noedge');
    // Entrada obsoleta: vértice mudou desde o push → recalcula e reenfileira.
    if (vertVersion[a] !== entry.va || vertVersion[b] !== entry.vb) {
      pushEdge(a, b);
      return reject('stale');
    }
    if ((options.preserveBorders || mustRemainWatertight) && edgeCounts.get(key) === 1) return reject('border');

    const aBoundary = vertOnBoundary[a] === 1;
    const bBoundary = vertOnBoundary[b] === 1;
    if (!boundaryCollapseAllowed(aBoundary, bBoundary, edgeCounts.get(key) === 1)) return reject('boundary-mix');

    const facesA = vertFaces[a].filter((f) => triAlive[f]);
    const facesB = vertFaces[b].filter((f) => triAlive[f]);
    const affectedSet = new Set<number>([...facesA, ...facesB]);
    const affected = [...affectedSet];

    // Link condition sobre a vizinhança VIVA.
    const neighA = neighborsOf(a);
    const neighB = neighborsOf(b);
    const shared = new Set<number>();
    for (const f of affected) {
      const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
      const hasA = i0 === a || i1 === a || i2 === a;
      const hasB = i0 === b || i1 === b || i2 === b;
      if (hasA && hasB) {
        for (const v of [i0, i1, i2]) if (v !== a && v !== b && vertAlive[v]) shared.add(v);
      }
    }
    if (!linkCondition(neighA, neighB, shared, a, b)) return reject('link');

    // Aresta non-manifold (3+ faces): colapso nunca é seguro aqui.
    if ((edgeCounts.get(key) ?? 2) > 2) return reject('nonmanifold-edge');

    // Conectividade LOCAL: o colapso identifica b em a e mata as faces
    // comuns; nenhum vértice da vizinhança pode ficar desconectado
    // (fragmentação criaria componentes indevidos + novos loops). BFS
    // restrita às faces afetadas sobreviventes — nunca global.
    {
      const regionFaces = new Set<number>();
      for (const f of affected) {
        const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
        const hasA = i0 === a || i1 === a || i2 === a;
        const hasB = i0 === b || i1 === b || i2 === b;
        if (hasA && hasB) continue; // face morre no colapso
        regionFaces.add(f);
      }
      const verts = new Set<number>();
      for (const f of regionFaces) {
        const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
        for (const v of [i0, i1, i2]) if (v !== b && vertAlive[v]) verts.add(v);
      }
      verts.add(a);
      const seen = new Set<number>([a]);
      const stack = [a];
      while (stack.length > 0) {
        const v = stack.pop() as number;
        for (const f of vertFaces[v]) {
          if (!regionFaces.has(f)) continue;
          const i0 = tri[f * 3] === b ? a : tri[f * 3];
          const i1 = tri[f * 3 + 1] === b ? a : tri[f * 3 + 1];
          const i2 = tri[f * 3 + 2] === b ? a : tri[f * 3 + 2];
          for (const o of [i0, i1, i2]) {
            if (o !== v && vertAlive[o] && !seen.has(o)) {
              seen.add(o);
              stack.push(o);
            }
          }
        }
      }
      let connected = true;
      for (const v of verts) {
        if (!seen.has(v)) {
          connected = false;
          break;
        }
      }
      if (!connected) return reject('fragment');
    }

    // FEATURE LOCK: aresta crítica só colapsa com erro quadrico minúsculo.
    // A severidade é herdada de TODA a vizinhança afetada (§6: "proximidade
    // de outras features") — uma aresta plana colada a um canto vivo usa o
    // limite do canto, não o da planície.
    let worstRegion = Math.max(
      complexity.region[a] ?? RegionClass.Plana,
      complexity.region[b] ?? RegionClass.Plana,
    );
    for (const f of affected) {
      const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
      const r0 = complexity.region[i0] ?? RegionClass.Plana;
      const r1 = complexity.region[i1] ?? RegionClass.Plana;
      const r2 = complexity.region[i2] ?? RegionClass.Plana;
      if (r0 > worstRegion) worstRegion = r0;
      if (r1 > worstRegion) worstRegion = r1;
      if (r2 > worstRegion) worstRegion = r2;
      if (worstRegion === RegionClass.FeatureCritica) break;
    }
    const lockedEdge = (complexity.locked[a] === 1 && complexity.locked[b] === 1);
    const lockGate = P.lockGate * planeMult * planeMult;
    if (lockedEdge && entry.cost > lockGate) return reject('lockgate');

    const strictDot = worstRegion === RegionClass.FeatureCritica ? P.dotCrit : worstRegion === RegionClass.MicroDetalhe ? P.dotMicro : worstRegion === RegionClass.AltaCurvatura ? 0.5 : 0.35;
    const maxAspect = worstRegion === RegionClass.FeatureCritica ? P.aspectCrit : worstRegion === RegionClass.MicroDetalhe ? P.aspectMicro : options.quality === 'low' ? 10 : 8;
    // O ponto médio está a 0.5*aresta de cada extremo: o limite precisa ser
    // >= 0.5 para nunca vetar o colapso mais seguro. A adaptatividade vem do
    // flip/aspecto/custo; o deslocamento só veta saltos (deformação).
    const strictness = worstRegion === RegionClass.FeatureCritica ? 0.8 : worstRegion === RegionClass.MicroDetalhe ? 1.0 : worstRegion === RegionClass.AltaCurvatura ? 1.2 : 1.4;
    const localEdge = Math.min(localEdgeLength(a), localEdgeLength(b));

    const readTriangle = (f: number): [number, number, number] => [tri[f * 3], tri[f * 3 + 1], tri[f * 3 + 2]];
    const faceNormalOf = (f: number): [number, number, number] => [faceNormals[f * 3], faceNormals[f * 3 + 1], faceNormals[f * 3 + 2]];

    // Candidatos de posição: ótimo QEM → ponto médio → extremos. Primeiro válido vence.
    const mid: [number, number, number] = [(pos[a * 3] + pos[b * 3]) / 2, (pos[a * 3 + 1] + pos[b * 3 + 1]) / 2, (pos[a * 3 + 2] + pos[b * 3 + 2]) / 2];
    const qa = quadrics[a]; const qb = quadrics[b];
    const score = (p: [number, number, number]): number =>
      (qa[0] + qb[0]) * p[0] * p[0] + 2 * (qa[1] + qb[1]) * p[0] * p[1] + 2 * (qa[2] + qb[2]) * p[0] * p[2] + 2 * (qa[3] + qb[3]) * p[0] +
      (qa[4] + qb[4]) * p[1] * p[1] + 2 * (qa[5] + qb[5]) * p[1] * p[2] + 2 * (qa[6] + qb[6]) * p[1] +
      (qa[7] + qb[7]) * p[2] * p[2] + 2 * (qa[8] + qb[8]) * p[2] + (qa[9] + qb[9]);
    // O ótimo QEM em regiões planas é degenerado no plano: o solver pode
    // devolver um ponto distante com QEM ≈ 0 (deriva). Descarta o ótimo se
    // ele saltar além do limite da região; o ponto médio é exato no plano.
    // Em features críticas o ótimo quase nunca é usado (só microajustes).
    const optimalGate = worstRegion === RegionClass.FeatureCritica ? 0.25 : worstRegion === RegionClass.MicroDetalhe ? 0.4 : worstRegion === RegionClass.AltaCurvatura ? 0.5 : 0.75;
    const optimal: [number, number, number] = [entry.x, entry.y, entry.z];
    const optimalSane =
      Number.isFinite(optimal[0]) && Number.isFinite(optimal[1]) && Number.isFinite(optimal[2]) &&
      displacementAllowed(
        pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2],
        optimal[0], optimal[1], optimal[2], localEdge, optimalGate,
      );
    const candidates: Array<[number, number, number]> = [
      ...(optimalSane ? [optimal] : []),
      mid,
      [pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2]] as [number, number, number],
      [pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2]] as [number, number, number],
    ].sort((p, q) => score(p) - score(q));

    let chosen: [number, number, number] | undefined;
    for (const p of candidates) {
      if (!Number.isFinite(p[0]) || !Number.isFinite(p[1]) || !Number.isFinite(p[2])) continue;
      if (!displacementAllowed(pos[a * 3], pos[a * 3 + 1], pos[a * 3 + 2], pos[b * 3], pos[b * 3 + 1], pos[b * 3 + 2], p[0], p[1], p[2], localEdge, strictness)) {
        if (dbg) dbg['cand-displacement'] = (dbg['cand-displacement'] ?? 0) + 1;
        continue;
      }
      // `a` parado (candidato = posição atual de `a`): faces só-de-`a` não
      // se movem — pular a revalidação delas destrava a redução perto de
      // slivers pré-existentes sem perder segurança.
      const aStatic = p[0] === pos[a * 3] && p[1] === pos[a * 3 + 1] && p[2] === pos[a * 3 + 2];
      if (dbg && (dbg['dumped'] ?? 0) < 6 && p === mid) {
        dbg['dumped'] = (dbg['dumped'] ?? 0) + 1;
        const probe: TriangleValidationStats = {
          checked: 0, skipped: 0, minDot: 2, maxAspect: 0,
          minAreaRatio: Infinity, maxAreaRatio: 0, failStage: 'pass',
        };
        validateResultTriangles(pos, getVertex, { a, b, position: p }, affected, readTriangle, faceNormalOf, {
          minDot: strictDot, minAreaRatio: 0.08, maxAreaRatio: 12, maxAspect, minArea,
        }, probe);
        (dbg as Record<string, unknown>)[`dump-${dbg['dumped']}`] =
          `edge(${a},${b}) wr=${worstRegion} aff=${affected.length} chk=${probe.checked} skp=${probe.skipped} ` +
          `fail=${probe.failStage} minDot=${probe.minDot.toFixed(3)} maxAsp=${probe.maxAspect.toFixed(2)} ` +
          `areaRatio=[${probe.minAreaRatio.toFixed(2)},${probe.maxAreaRatio.toFixed(2)}]`;
      }
      if (!validateResultTriangles(pos, getVertex, { a, b, position: p }, affected, readTriangle, faceNormalOf, {
        minDot: strictDot,
        minAreaRatio: 0.08,
        maxAreaRatio: 12,
        maxAspect,
        minArea,
      }, undefined, aStatic)) continue;
      chosen = p;
      break;
    }
    if (!chosen) return reject('no-placement');

    // Deriva acumulada desde o ORIGINAL (erro local tem prioridade sobre o
    // médio): o vértice sobrevivente e o arrastado precisam estar dentro do
    // teto normal/tangencial. Colapsos exatos sobre a superfície passam;
    // amassos fora da superfície são vetados antes do COMMIT.
    const regionFactor = worstRegion === RegionClass.FeatureCritica ? 0.5 : worstRegion === RegionClass.MicroDetalhe ? 0.75 : 1;
    // Teto por operação: a nova posição não pode sair do plano de NENHUMA
    // face afetada sobrevivente além de planeCap. Deslizamentos sobre a
    // superfície (distância ≈ 0) passam; amassos são vetados na hora, sem
    // depender de validação global posterior.
    const planeCap = driftCapNormalBase * regionFactor * planeMult;
    for (const f of affected) {
      let i0 = tri[f * 3]; let i1 = tri[f * 3 + 1]; let i2 = tri[f * 3 + 2];
      if (i0 === b) i0 = a;
      if (i1 === b) i1 = a;
      if (i2 === b) i2 = a;
      if (i0 === i1 || i1 === i2 || i0 === i2) continue; // face morre no colapso
      const nx = faceNormals[f * 3]; const ny = faceNormals[f * 3 + 1]; const nz = faceNormals[f * 3 + 2];
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 1e-24)) return reject('plane-degenerate');
      const px = pos[i0 * 3]; const py = pos[i0 * 3 + 1]; const pz = pos[i0 * 3 + 2];
      const dist = Math.abs(nx * (chosen[0] - px) + ny * (chosen[1] - py) + nz * (chosen[2] - pz)) / nl;
      if (!(dist <= planeCap)) return reject('plane-cap');
    }
    if (!driftAllowed(a, chosen[0], chosen[1], chosen[2], regionFactor)) return reject('drift-a');
    if (!driftAllowed(b, chosen[0], chosen[1], chosen[2], regionFactor)) return reject('drift-b');

    // ---------------- COMMIT (atualização incremental EXATA) ----------------
    // Remove as arestas das faces afetadas ANTES de remapear.
    for (const f of affected) {
      const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
      removeEdge(i0, i1, f); removeEdge(i1, i2, f); removeEdge(i2, i0, f);
      removeFromList(vertFaces[i0], f);
      removeFromList(vertFaces[i1], f);
      removeFromList(vertFaces[i2], f);
    }
    pos[a * 3] = chosen[0]; pos[a * 3 + 1] = chosen[1]; pos[a * 3 + 2] = chosen[2];
    addQuadricInPlace(quadrics[a], quadrics[b]);
    vertAlive[b] = 0;
    vertVersion[a] += 1;
    vertVersion[b] += 1;
    // Herda a importância máxima (feature nunca é esquecida ao fundir).
    if ((complexity.feature[b] ?? 0) > (complexity.feature[a] ?? 0)) complexity.feature[a] = complexity.feature[b] ?? 0;
    if ((complexity.curvature[b] ?? 0) > (complexity.curvature[a] ?? 0)) complexity.curvature[a] = complexity.curvature[b] ?? 0;
    if ((complexity.thin[b] ?? 0) > (complexity.thin[a] ?? 0)) complexity.thin[a] = complexity.thin[b] ?? 0;
    if ((complexity.silhouette[b] ?? 0) > (complexity.silhouette[a] ?? 0)) complexity.silhouette[a] = complexity.silhouette[b] ?? 0;
    if (complexity.locked[b] === 1) complexity.locked[a] = 1;
    if ((complexity.region[b] ?? 0) > (complexity.region[a] ?? 0)) complexity.region[a] = complexity.region[b] ?? 0;
    if (vertOnBoundary[b] === 1) vertOnBoundary[a] = 1;

    let removedFaces = 0;
    for (const f of affected) {
      let i0 = tri[f * 3]; let i1 = tri[f * 3 + 1]; let i2 = tri[f * 3 + 2];
      if (i0 === b) i0 = a;
      if (i1 === b) i1 = a;
      if (i2 === b) i2 = a;
      if (i0 === i1 || i1 === i2 || i0 === i2) {
        triAlive[f] = 0;
        removedFaces += 1;
        // Contabiliza a cota da região que pagou por este colapso.
        const r0 = complexity.region[tri[f * 3]] ?? 0;
        const r1 = complexity.region[tri[f * 3 + 1]] ?? 0;
        const r2 = complexity.region[tri[f * 3 + 2]] ?? 0;
        regionRemoved[Math.max(r0, r1, r2)] += 1;
        continue;
      }
      tri[f * 3] = i0; tri[f * 3 + 1] = i1; tri[f * 3 + 2] = i2;
      // Recalcula a normal da face movida.
      const ax = pos[i0 * 3]; const ay = pos[i0 * 3 + 1]; const az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3]; const by = pos[i1 * 3 + 1]; const bz = pos[i1 * 3 + 2];
      const cx = pos[i2 * 3]; const cy = pos[i2 * 3 + 1]; const cz = pos[i2 * 3 + 2];
      const abx = bx - ax; const aby = by - ay; const abz = bz - az;
      const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
      faceNormals[f * 3] = aby * acz - abz * acy;
      faceNormals[f * 3 + 1] = abz * acx - abx * acz;
      faceNormals[f * 3 + 2] = abx * acy - aby * acx;
      vertFaces[i0].push(f); vertFaces[i1].push(f); vertFaces[i2].push(f);
      addEdge(i0, i1, f); addEdge(i1, i2, f); addEdge(i2, i0, f);
      pushEdge(i0, i1); pushEdge(i1, i2); pushEdge(i2, i0);
      // Vizinhança do vértice movido precisa de novas opções.
      vertVersion[i0] += 0;
    }
    vertVersion[a] += 1;
    activeTriangles -= removedFaces;
    if (dbg) {
      dbg['commit'] = (dbg['commit'] ?? 0) + 1;
      dbg['removed'] = (dbg['removed'] ?? 0) + removedFaces;
    }
    return removedFaces > 0;
  };

  // ------------------------------------------------------------------
  // DECIMAÇÃO PROGRESSIVA POR ESTÁGIOS + ROLLBACK + QUALITY FLOOR
  // ------------------------------------------------------------------
  let activeTriangles = originalTriangles;
  const targets = stageTargets(originalTriangles, target);
  const totalStages = targets.length;

  const buildCompact = (): { positions: Float32Array; indices: Uint32Array } => {
    const used = new Set<number>();
    for (let t = 0; t < originalTriangles; t += 1) {
      if (!triAlive[t]) continue;
      used.add(tri[t * 3]); used.add(tri[t * 3 + 1]); used.add(tri[t * 3 + 2]);
    }
    const remap = new Map<number, number>();
    const outPos: number[] = [];
    let next = 0;
    for (const v of used) {
      remap.set(v, next);
      outPos.push(pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      next += 1;
    }
    const outIdx: number[] = [];
    for (let t = 0; t < originalTriangles; t += 1) {
      if (!triAlive[t]) continue;
      const a = tri[t * 3]; const b = tri[t * 3 + 1]; const c = tri[t * 3 + 2];
      if (a === b || b === c || a === c) continue;
      // TOPOLOGIA SUPREMA: nunca remover faces vivas por qualidade (aspecto).
      // Slivers pré-existentes fazem parte do estado original; deletá-los
      // aqui criaria buracos e fragmentos que os colapsos nunca fizeram.
      // Os gates por operação (aspecto ≤ 8 nas faces movidas, área mínima
      // relativa) já garantem que NENHUM triângulo ruim é CRIADO.
      const ax = pos[a * 3]; const ay = pos[a * 3 + 1]; const az = pos[a * 3 + 2];
      const bx = pos[b * 3]; const by = pos[b * 3 + 1]; const bz = pos[b * 3 + 2];
      const cx = pos[c * 3]; const cy = pos[c * 3 + 1]; const cz = pos[c * 3 + 2];
      const abx = bx - ax; const aby = by - ay; const abz = bz - az;
      const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
      const nx = aby * acz - abz * acy;
      const ny = abz * acx - abx * acz;
      const nz = abx * acy - aby * acx;
      if (nx * nx + ny * ny + nz * nz <= 1e-24) continue;
      outIdx.push(remap.get(a) as number, remap.get(b) as number, remap.get(c) as number);
    }
    return { positions: new Float32Array(outPos), indices: new Uint32Array(outIdx) };
  };

  // Snapshot do melhor estado válido (inicia com o original).
  let bestValid: { positions: Float32Array; indices: Uint32Array; triangles: number } = {
    positions: mesh.positions.slice() as Float32Array,
    indices: mesh.indices.slice() as Uint32Array,
    triangles: originalTriangles,
  };
  let bestStageReached = -1;
  const warnings: string[] = [];
  let stoppedSafely = false;
  let iterations = 0;
  // Multiplicador de escalonamento anti-stall (relaxa teto por plano e
  // lock-gate de forma limitada quando o estágio trava sem progresso).
  let planeMult = 1;
  // Orçamento em COMMITS (trabalho real), não em pops da fila: entradas
  // obsoletas/mortas da heap preguiçosa não podem consumir o orçamento.
  // O teto de parede (time budget, 60s) continua como trava principal.
  const maxCommits = Math.max(10_000, originalTriangles * 2);

  // Grade estática sobre a REFERÊNCIA (construída uma vez): todas as
  // medições de distância e o reparo local consultam a mesma estrutura.
  const refGrid = buildTriangleGrid(mesh.positions, mesh.indices);

  // Variação de normais inicial por vértice (base do erro de curvatura).
  const initVar = new Float64Array(vertexCount);
  const curvatureVarOf = (v: number): number => {
    const incident = vertFaces[v];
    const n = incident.length;
    if (n < 2) return 0;
    let variation = 0;
    const step = n > 8 ? Math.floor(n / 8) : 1;
    for (let i = 0; i < n; i += step) {
      const f0 = incident[i];
      if (!triAlive[f0]) continue;
      const l0 = Math.hypot(faceNormals[f0 * 3], faceNormals[f0 * 3 + 1], faceNormals[f0 * 3 + 2]);
      if (l0 < 1e-18) continue;
      for (let j = i + step; j < n; j += step) {
        const f1 = incident[j];
        if (!triAlive[f1]) continue;
        const l1 = Math.hypot(faceNormals[f1 * 3], faceNormals[f1 * 3 + 1], faceNormals[f1 * 3 + 2]);
        if (l1 < 1e-18) continue;
        const cos = Math.max(-1, Math.min(1,
          (faceNormals[f0 * 3] * faceNormals[f1 * 3] + faceNormals[f0 * 3 + 1] * faceNormals[f1 * 3 + 1] + faceNormals[f0 * 3 + 2] * faceNormals[f1 * 3 + 2]) / (l0 * l1)));
        const v01 = 1 - cos;
        if (v01 > variation) variation = v01;
      }
    }
    return variation;
  };
  for (let v = 0; v < vertexCount; v += 1) initVar[v] = curvatureVarOf(v);

  /** Erro de normal amostrado: desvio médio/máx vs. normais originais. */
  const sampledNormalError = (samples: number): { mean: number; max: number } => {
    const stride = Math.max(1, Math.floor(vertexCount / samples));
    let sum = 0; let max = 0; let taken = 0;
    for (let v = 0; v < vertexCount && taken < samples; v += stride) {
      if (!vertAlive[v]) continue;
      let nx = 0; let ny = 0; let nz = 0;
      for (const f of vertFaces[v]) {
        if (!triAlive[f]) continue;
        nx += faceNormals[f * 3]; ny += faceNormals[f * 3 + 1]; nz += faceNormals[f * 3 + 2];
      }
      const l = Math.hypot(nx, ny, nz);
      if (l < 1e-18) continue;
      const ox = origNormals[v * 3]; const oy = origNormals[v * 3 + 1]; const oz = origNormals[v * 3 + 2];
      const ol = Math.hypot(ox, oy, oz);
      if (ol < 0.5) continue;
      const dev = 1 - Math.max(-1, Math.min(1, (nx * ox + ny * oy + nz * oz) / (l * ol)));
      sum += dev;
      if (dev > max) max = dev;
      taken += 1;
    }
    return { mean: taken > 0 ? sum / taken : 0, max };
  };

  /** Erro de curvatura amostrado: |variação atual − inicial|. */
  const sampledCurvatureError = (samples: number): { mean: number; max: number } => {
    const stride = Math.max(1, Math.floor(vertexCount / samples));
    let sum = 0; let max = 0; let taken = 0;
    for (let v = 0; v < vertexCount && taken < samples; v += stride) {
      if (!vertAlive[v]) continue;
      const diff = Math.abs(curvatureVarOf(v) - initVar[v]);
      sum += diff;
      if (diff > max) max = diff;
      taken += 1;
    }
    return { mean: taken > 0 ? sum / taken : 0, max };
  };

  interface StageCheck {
    ok: boolean;
    kind: 'topology' | 'metric';
    reasons: string[];
    mean: number;
    max: number;
    silhouette: number;
    normal: number;
    curvature: number;
  }

  const validateStage = (candidate: { positions: Float32Array; indices: Uint32Array }): StageCheck => {
    const reasons: string[] = [];
    const candidateMesh: MeshData = {
      positions: candidate.positions,
      indices: candidate.indices,
      format: mesh.format,
      bounds: mesh.bounds,
    };
    const audit = auditMesh(candidateMesh, referenceAudit);
    reasons.push(...audit.reasons);
    if (!audit.valid) return { ok: false, kind: 'topology', reasons, mean: 0, max: 0, silhouette: 0, normal: 0, curvature: 0 };
    const tolForVolume = curProfile ? P.bndMax / 100 : 0.025;
    if (!auditWithinTolerance(audit, referenceAudit, tolForVolume)) {
      reasons.push('Volume ou dimensões excederam a tolerância do estágio.');
      return { ok: false, kind: 'metric', reasons, mean: 0, max: 0, silhouette: 0, normal: 0, curvature: 0 };
    }
    // Superfície: vértices candidatos → grade estática da referência.
    const candVerts = candidate.positions.length / 3;
    const err = directedSamplesError(refGrid, candidate.positions, candVerts, null, diagonal, candVerts * 3 > 200000 ? 500 : 900);
    // Silhueta multivista (X, Y, Z + 4 diagonais).
    const sil = silhouetteError(mesh.positions, vertexCount, pos, vertexCount, vertAlive, diagonal);
    // Normal + curvatura amostrados sobre o estado de trabalho.
    const norm = sampledNormalError(1500);
    const curv = sampledCurvatureError(1500);
    let ok = true;
    if (err.mean > P.floorMean) {
      ok = false;
      reasons.push(`Erro médio de superfície ${(err.mean * 100).toFixed(3)}% excedeu o piso de qualidade.`);
    } else if (err.max > P.floorMax) {
      ok = false;
      reasons.push(`Erro máximo de superfície ${(err.max * 100).toFixed(3)}% excedeu o piso de qualidade.`);
    }
    if (ok && sil > P.silhouetteMax) {
      ok = false;
      reasons.push(`Erro de silhueta ${(sil * 100).toFixed(2)}% excedeu o limite.`);
    }
    if (ok && norm.mean > P.normalMax) {
      ok = false;
      reasons.push(`Desvio de normais ${(norm.mean * 100).toFixed(3)} excedeu o limite.`);
    }
    if (ok && curv.mean > P.curvatureMax) {
      ok = false;
      reasons.push(`Erro de curvatura ${(curv.mean * 100).toFixed(3)} excedeu o limite.`);
    }
    return { ok, kind: 'metric', reasons, mean: err.mean, max: err.max, silhouette: sil, normal: norm.mean, curvature: curv.mean };
  };

  /** Recalcula normais das faces (consistência após reparo local). */
  const refreshFaceNormals = (faces: Set<number>): void => {
    for (const f of faces) {
      if (!triAlive[f]) continue;
      const i0 = tri[f * 3]; const i1 = tri[f * 3 + 1]; const i2 = tri[f * 3 + 2];
      const ax = pos[i0 * 3]; const ay = pos[i0 * 3 + 1]; const az = pos[i0 * 3 + 2];
      const bx = pos[i1 * 3]; const by = pos[i1 * 3 + 1]; const bz = pos[i1 * 3 + 2];
      const cx = pos[i2 * 3]; const cy = pos[i2 * 3 + 1]; const cz = pos[i2 * 3 + 2];
      faceNormals[f * 3] = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      faceNormals[f * 3 + 1] = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      faceNormals[f * 3 + 2] = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    }
  };

  /**
   * REPARO LOCAL (sem fill-hole): localiza os vértices mais afastados da
   * referência (via grade estática), projeta-os 50% de volta à superfície
   * original e atualiza normais/versões. O chamador revalida o estágio;
   * se continuar reprovado, o rollback descarta tudo.
   */
  const attemptRepair = (): boolean => {
    const stride = Math.max(1, Math.floor(vertexCount / 3000));
    const repairTol = P.floorMax * diagonal * 0.5;
    const touched = new Set<number>();
    let moved = 0;
    for (let v = 0; v < vertexCount; v += stride) {
      if (!vertAlive[v]) continue;
      const q = queryGridClosest(refGrid, pos[v * 3], pos[v * 3 + 1], pos[v * 3 + 2]);
      if (Math.sqrt(q.dist2) <= repairTol) continue;
      pos[v * 3] = (pos[v * 3] + q.qx) / 2;
      pos[v * 3 + 1] = (pos[v * 3 + 1] + q.qy) / 2;
      pos[v * 3 + 2] = (pos[v * 3 + 2] + q.qz) / 2;
      vertVersion[v] += 1;
      for (const f of vertFaces[v]) touched.add(f);
      moved += 1;
      if (moved >= 500) break;
    }
    if (moved === 0) return false;
    refreshFaceNormals(touched);
    return true;
  };

  let qualityBlocked = false;

  for (let stage = 0; stage < totalStages; stage += 1) {
    const stageTarget = targets[stage];
    let attempts = 0;
    let failed = false;
    while (attempts < 3) {
      const stageStartActive = activeTriangles;
      let stageCommits = 0;
      let stagePops = 0;
      // Teto do estágio em COMMITS (+ folga para tentativas): pops obsoletos
      // da heap preguiçosa não consomem o orçamento do estágio.
      const stageCommitCap = Math.max(1000, (stageStartActive - stageTarget + 1) * 3);
      const stagePopsCap = Math.max(10_000, (stageStartActive - stageTarget + 1) * 40);
      while (activeTriangles > stageTarget && commits < maxCommits) {
        if (timedOut() || options.onCheckpoint?.(activeTriangles) === false) {
          stoppedSafely = true;
          stoppedReason = 'time';
          break;
        }
        iterations += 1;
        stagePops += 1;
        if (stageCommits > stageCommitCap || stagePops > stagePopsCap) break; // evita loop infinito em malha travada
        const candidate = heap.pop();
        if (!candidate) break;
        if (tryCollapse(candidate)) {
          commits += 1;
          stageCommits += 1;
        }
        if (iterations % 4000 === 0) {
          const overall = 1 - (activeTriangles - target) / Math.max(1, originalTriangles - target);
          onProgress?.(Math.min(0.97, Math.max(0.03, 0.05 + overall * 0.85)));
        }
      }
      if (stoppedSafely || timedOut()) {
        stoppedReason = 'time';
        break;
      }

      // Valida o estágio; em falha métrica, tenta reparo local uma vez.
      const dbgStage = (globalThis as Record<string, unknown>).__MESH_DEBUG as Record<string, number> | undefined;
      if (dbgStage) {
        dbgStage[`stage-${stage}-active`] = activeTriangles;
        dbgStage[`stage-${stage}-heap`] = heap.size;
        dbgStage[`stage-${stage}-iters`] = iterations;
      }
      const compact = buildCompact();
      let check = validateStage(compact);
      if (!check.ok && check.kind === 'metric' && attempts === 0) {
        if (attemptRepair()) {
          const recheck = validateStage(buildCompact());
          if (recheck.ok) {
            check = recheck;
          } else {
            warnings.push(`Reparo local insuficiente no estágio ${stage + 1}/${totalStages}; mantido o melhor estado válido.`);
          }
        }
      }
      if (check.ok) {
        bestValid = { positions: compact.positions, indices: compact.indices, triangles: compact.indices.length / 3 };
        bestStageReached = stage;
        stagesCompleted += 1;
        lastMetrics.mean = check.mean;
        lastMetrics.max = check.max;
        lastMetrics.silhouette = check.silhouette;
        lastMetrics.normal = check.normal;
        lastMetrics.curvature = check.curvature;
        activeTriangles = bestValid.triangles;
        const overall = 1 - (activeTriangles - target) / Math.max(1, originalTriangles - target);
        onProgress?.(Math.min(0.97, Math.max(0.03, 0.05 + overall * 0.85)));
        break;
      }
      // Sem progresso (<2% do necessário)? Cascata de estratégias (§26-27):
      // 1) relaxa teto por plano (áreas simples pagam mais); 2) sobe o
      // perfil (balanced→aggressive→maximum), registrado no log — nunca
      // falha silenciosamente. Falha topológica nunca escala: rollback.
      const made = stageStartActive - activeTriangles;
      const needed = Math.max(1, stageStartActive - stageTarget);
      if (check.kind === 'metric' && made < needed * 0.02 && !timedOut()) {
        if (escalations < 2 && attempts < 2) {
          escalations += 1;
          planeMult *= 1.6;
          attempts += 1;
          continue;
        }
        const next = nextProfile(curProfile);
        if (next && profileEscalations < 3) {
          profileEscalations += 1;
          applyProfile(next);
          warnings.push(
            `Estratégia ${profileEscalations + 1}: perfil ${next} (estágio ${stage + 1} travou em ${activeTriangles.toLocaleString('pt-BR')} faces; motivo: ${check.reasons[0] ?? 'limite de qualidade'}).`,
          );
          attempts = 0;
          continue;
        }
      }
      warnings.push(`Estágio ${stage + 1}/${totalStages} rejeitado pela validação: ${check.reasons.join(' ')}`);
      qualityBlocked = true;
      stoppedReason = 'quality';
      failed = true;
      if ((globalThis as Record<string, unknown>).__MESH_DEBUG) {
        console.error(`[stage-reject] stage=${stage} totalStages=${totalStages} targets=${JSON.stringify(targets)} active=${activeTriangles} kind=${check.kind}`);
      }
      break; // mantém o melhor estado válido (target flexível)
    }
    if (failed || stoppedSafely || timedOut()) break;
    if (activeTriangles <= target) {
      stoppedReason = 'target';
      break;
    }
  }
  if (stoppedReason === 'target' && bestValid.triangles > target && !timedOut()) {
    stoppedReason = qualityBlocked ? 'quality' : 'stall';
  }

  /**
   * FAIRING curvature-aware (uma passada, conservadora): relaxamento
   * tangencial APENAS em regiões planas/curvas, limitado pela deriva,
   * revalidado integralmente. Se reprovar, bestValid (cópias) prevalece —
   * nada se perde. Nunca toca features, nunca é global, nunca esconde
   * defeito (só roda sobre estado já validado).
   */
  const fairingPass = (): StageCheck | null => {
    if (activeTriangles !== bestValid.triangles) return null;
    const touched = new Set<number>();
    let moved = 0;
    for (let v = 0; v < vertexCount && moved < 20000; v += 1) {
      if (!vertAlive[v]) continue;
      if ((complexity.region[v] ?? 0) >= RegionClass.AltaCurvatura) continue;
      const neighbors = neighborsOf(v);
      if (neighbors.size < 3) continue;
      let cx = 0; let cy = 0; let cz = 0;
      for (const o of neighbors) {
        cx += pos[o * 3]; cy += pos[o * 3 + 1]; cz += pos[o * 3 + 2];
      }
      cx /= neighbors.size; cy /= neighbors.size; cz /= neighbors.size;
      const nx = origNormals[v * 3]; const ny = origNormals[v * 3 + 1]; const nz = origNormals[v * 3 + 2];
      const nl = Math.hypot(nx, ny, nz);
      if (!(nl > 0.5)) continue;
      let dx = (cx - pos[v * 3]) * 0.2;
      let dy = (cy - pos[v * 3 + 1]) * 0.2;
      let dz = (cz - pos[v * 3 + 2]) * 0.2;
      const dn = (dx * nx + dy * ny + dz * nz) / (nl * nl);
      dx -= dn * nx; dy -= dn * ny; dz -= dn * nz;
      const qx = pos[v * 3] + dx; const qy = pos[v * 3 + 1] + dy; const qz = pos[v * 3 + 2] + dz;
      if (!driftAllowed(v, qx, qy, qz, 0.5)) continue;
      pos[v * 3] = qx; pos[v * 3 + 1] = qy; pos[v * 3 + 2] = qz;
      vertVersion[v] += 1;
      for (const f of vertFaces[v]) touched.add(f);
      moved += 1;
    }
    if (moved === 0) return null;
    refreshFaceNormals(touched);
    return validateStage(buildCompact());
  };

  if (bestStageReached < 0) {
    // Nenhum estágio avançou com segurança: devolve o melhor esforço validado.
    const compact = buildCompact();
    const check = validateStage(compact);
    if (check.ok && compact.indices.length / 3 < originalTriangles) {
      bestValid = { positions: compact.positions, indices: compact.indices, triangles: compact.indices.length / 3 };
      lastMetrics.mean = check.mean;
      lastMetrics.max = check.max;
      lastMetrics.silhouette = check.silhouette;
      lastMetrics.normal = check.normal;
      lastMetrics.curvature = check.curvature;
    }
  } else if (bestValid.triangles < originalTriangles && bestValid.triangles > target) {
    // Polimento opcional quando o alvo não foi atingido: tenta melhorar a
    // distribuição sem mudar a contagem de faces.
    const polished = fairingPass();
    if (polished && polished.ok) {
      const compact = buildCompact();
      bestValid = { positions: compact.positions, indices: compact.indices, triangles: compact.indices.length / 3 };
      lastMetrics.mean = polished.mean;
      lastMetrics.max = polished.max;
      lastMetrics.silhouette = polished.silhouette;
      lastMetrics.normal = polished.normal;
      lastMetrics.curvature = polished.curvature;
    }
  }

  if (bestValid.triangles > target) {
    if (qualityBlocked || stoppedReason === 'quality') {
      warnings.push('Redução máxima segura atingida: a qualidade impediu avançar ao alvo sem deformar o modelo. Entregue o melhor estado válido.');
    } else if (stoppedReason === 'time') {
      warnings.push('Tempo máximo atingido: entregue o melhor estado válido até o momento.');
    } else if (bestValid.triangles >= originalTriangles) {
      stoppedReason = 'stall';
      warnings.push('Nenhuma redução segura foi possível; o original foi preservado intacto.');
    } else {
      warnings.push('A preservação geométrica impediu atingir o alvo; o melhor estado seguro foi mantido.');
    }
  }

  const finalPositions = bestValid.positions;
  const finalIndices = bestValid.indices;
  const normalized = compactMesh(Array.from(finalPositions), Array.from(finalIndices), mesh.format);
  return finishWith(normalized.positions, normalized.indices, warnings, stoppedSafely || bestValid.triangles > target);
}
