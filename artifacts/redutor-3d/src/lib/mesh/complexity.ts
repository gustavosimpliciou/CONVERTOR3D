/**
 * GEOMETRIC COMPLEXITY MAP + FEATURE DETECTION
 * --------------------------------------------
 * Núcleo da decimação adaptativa: cada vértice recebe uma pontuação de
 * importância geométrica que controla a agressividade da redução.
 *
 * - ÁREA PLANA            → redução agressiva
 * - BAIXA CURVATURA       → redução alta
 * - CURVATURA MÉDIA       → redução moderada
 * - ALTA CURVATURA        → redução conservadora
 * - MICRODETALHE          → redução mínima
 * - FEATURE CRÍTICA       → protegida (feature lock)
 *
 * Métricas combinadas por vértice:
 *  - variação de normais das faces incidentes (1 - cos)
 *  - dihedral angle máximo das arestas incidentes
 *  - densidade local (comprimento médio das arestas vs. mediana global)
 *  - tamanho médio das faces incidentes vs. média global
 *  - concavidade/convexidade (sinal do ângulo diedral)
 *  - borda / silhueta (arestas com apenas 1 face)
 *  - estrutura fina (arestas curtas + alta curvatura + faces pequenas)
 *
 * General-purpose: nenhuma heurística depende de "rosto", "olho" ou "mão".
 * Regiões de alta frequência geométrica (olhos, boca, dedos, cabelo, relevos)
 * emergem naturalmente como ALTA_CURVATURA / MICRODETALHE / FEATURE_CRITICA.
 */

export enum RegionClass {
  Plana = 0,
  Curva = 1,
  AltaCurvatura = 2,
  MicroDetalhe = 3,
  FeatureCritica = 4,
}

export interface ComplexityMap {
  /** Curvatura normalizada 0..1 por vértice. */
  curvature: Float64Array;
  /** Peso de feature 0..1 por vértice (sharp edges, cavidades, relevos). */
  feature: Float64Array;
  /** Peso de estrutura fina 0..1 (dedos, mechas, paredes finas). */
  thin: Float64Array;
  /** Peso de silhueta/borda 0..1. */
  silhouette: Float64Array;
  /** Classe da região por vértice. */
  region: Uint8Array;
  /** true quando o vértice está sob FEATURE LOCK. */
  locked: Uint8Array;
  /** Estatísticas globais usadas pelos limites de qualidade. */
  avgEdgeLength: number;
  avgFaceArea: number;
  diagonal: number;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

export function edgeKeyOf(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

export interface ComplexityInputs {
  positions: Float64Array | number[];
  /** Triângulos vivos em formato flat [t0a, t0b, t0c, t1a, ...]. Vértices >= 0. */
  triangles: Int32Array | number[];
  triangleCount: number;
  vertexCount: number;
  faceNormals: Float64Array; // 3 por triângulo (não normalizadas)
  vertexFaces: Array<number[]>;
  edgeCounts: Map<string, number>;
  edgeFaces: Map<string, number[]>; // até 2+ faces por aresta (para dihedral)
  boundsSize: [number, number, number];
}

/**
 * Calcula o mapa de complexidade. Roda UMA vez antes da decimação
 * (fase IDENTIFICANDO FEATURES) e é reutilizado como referência imutável.
 */
export function computeComplexityMap(inputs: ComplexityInputs): ComplexityMap {
  const { vertexCount, triangleCount, faceNormals, vertexFaces, edgeCounts, edgeFaces } = inputs;
  const curvature = new Float64Array(vertexCount);
  const feature = new Float64Array(vertexCount);
  const thin = new Float64Array(vertexCount);
  const silhouette = new Float64Array(vertexCount);
  const region = new Uint8Array(vertexCount);
  const locked = new Uint8Array(vertexCount);

  const diagonal = Math.hypot(inputs.boundsSize[0], inputs.boundsSize[1], inputs.boundsSize[2]) || 1;

  // --- Estatísticas globais: comprimento médio de aresta e área média ---
  let edgeSum = 0;
  let edgeSamples = 0;
  let areaSum = 0;
  const pos = inputs.positions;
  const tris = inputs.triangles;
  const tmpAreas = new Float64Array(Math.max(1, triangleCount));
  for (let t = 0; t < triangleCount; t += 1) {
    const a = tris[t * 3];
    const b = tris[t * 3 + 1];
    const c = tris[t * 3 + 2];
    if (a < 0 || b < 0 || c < 0) continue;
    const ax = pos[a * 3]; const ay = pos[a * 3 + 1]; const az = pos[a * 3 + 2];
    const bx = pos[b * 3]; const by = pos[b * 3 + 1]; const bz = pos[b * 3 + 2];
    const cx = pos[c * 3]; const cy = pos[c * 3 + 1]; const cz = pos[c * 3 + 2];
    edgeSum += Math.hypot(bx - ax, by - ay, bz - az) + Math.hypot(cx - bx, cy - by, cz - bz) + Math.hypot(ax - cx, ay - cy, az - cz);
    edgeSamples += 3;
    const nx = faceNormals[t * 3]; const ny = faceNormals[t * 3 + 1]; const nz = faceNormals[t * 3 + 2];
    const area = Math.hypot(nx, ny, nz) / 2;
    tmpAreas[t] = area;
    areaSum += area;
  }
  const avgEdgeLength = edgeSamples > 0 ? edgeSum / edgeSamples : diagonal * 1e-3;
  const aliveTris = Math.max(1, triangleCount);
  const avgFaceArea = areaSum / aliveTris;

  // --- Dihedral máximo por vértice (via arestas com 2 faces) ---
  const maxDihedral = new Float64Array(vertexCount);
  const concave = new Float64Array(vertexCount);
  const convex = new Float64Array(vertexCount);
  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const [f0, f1] = faces;
    const n0x = faceNormals[f0 * 3]; const n0y = faceNormals[f0 * 3 + 1]; const n0z = faceNormals[f0 * 3 + 2];
    const n1x = faceNormals[f1 * 3]; const n1y = faceNormals[f1 * 3 + 1]; const n1z = faceNormals[f1 * 3 + 2];
    const l0 = Math.hypot(n0x, n0y, n0z);
    const l1 = Math.hypot(n1x, n1y, n1z);
    if (l0 < 1e-18 || l1 < 1e-18) continue;
    const cos = Math.max(-1, Math.min(1, (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1)));
    const angle = Math.acos(cos); // 0 = coplanar, π = dobra total
    const sep = key.indexOf(':');
    const a = Number(key.slice(0, sep));
    const b = Number(key.slice(sep + 1));
    if (angle > maxDihedral[a]) maxDihedral[a] = angle;
    if (angle > maxDihedral[b]) maxDihedral[b] = angle;
    // Sinal: produto da aresta pelo vetor entre centroides indica dobra.
    // Aproximação barata: usa orientação relativa das normais no eixo da aresta.
    const ex = pos[b * 3] - pos[a * 3];
    const ey = pos[b * 3 + 1] - pos[a * 3 + 1];
    const ez = pos[b * 3 + 2] - pos[a * 3 + 2];
    const crossx = n0y * n1z - n0z * n1y;
    const crossy = n0z * n1x - n0x * n1z;
    const crossz = n0x * n1y - n0y * n1x;
    const sign = crossx * ex + crossy * ey + crossz * ez;
    if (sign > 0) {
      if (angle > convex[a]) convex[a] = angle;
      if (angle > convex[b]) convex[b] = angle;
    } else if (sign < 0) {
      if (angle > concave[a]) concave[a] = angle;
      if (angle > concave[b]) concave[b] = angle;
    }
  }

  // --- Por vértice: variação de normais + densidade + área local ---
  for (let v = 0; v < vertexCount; v += 1) {
    const incident = vertexFaces[v];
    if (!incident || incident.length === 0) {
      region[v] = RegionClass.Plana;
      continue;
    }
    let normalVar = 0;
    // Amostragem limitada: compara até 8 faces para não explodir em hubs.
    const n = incident.length;
    const step = n > 8 ? Math.floor(n / 8) : 1;
    for (let i = 0; i < n; i += step) {
      const f0 = incident[i];
      const n0x = faceNormals[f0 * 3]; const n0y = faceNormals[f0 * 3 + 1]; const n0z = faceNormals[f0 * 3 + 2];
      const l0 = Math.hypot(n0x, n0y, n0z);
      if (l0 < 1e-18) continue;
      for (let j = i + step; j < n; j += step) {
        const f1 = incident[j];
        const n1x = faceNormals[f1 * 3]; const n1y = faceNormals[f1 * 3 + 1]; const n1z = faceNormals[f1 * 3 + 2];
        const l1 = Math.hypot(n1x, n1y, n1z);
        if (l1 < 1e-18) continue;
        const cos = Math.max(-1, Math.min(1, (n0x * n1x + n0y * n1y + n0z * n1z) / (l0 * l1)));
        const v01 = 1 - cos; // 0 = plano, 2 = oposto
        if (v01 > normalVar) normalVar = v01;
      }
    }

    // Densidade local: arestas curtas + faces pequenas = detalhe fino.
    let localEdge = 0;
    let localCount = 0;
    let localArea = 0;
    const vx = pos[v * 3]; const vy = pos[v * 3 + 1]; const vz = pos[v * 3 + 2];
    for (let k = 0; k < n; k += 1) {
      const f = incident[k];
      const a = tris[f * 3]; const b = tris[f * 3 + 1]; const c = tris[f * 3 + 2];
      const others = a === v ? [b, c] : b === v ? [a, c] : [a, b];
      for (const o of others) {
        localEdge += Math.hypot(pos[o * 3] - vx, pos[o * 3 + 1] - vy, pos[o * 3 + 2] - vz);
        localCount += 1;
      }
      localArea += tmpAreas[f] ?? 0;
    }
    const meanEdge = localCount > 0 ? localEdge / localCount : avgEdgeLength;
    const meanArea = n > 0 ? localArea / n : avgFaceArea;
    const densityScore = clamp01(Math.log10((avgEdgeLength + 1e-18) / (meanEdge + 1e-18)) / 2 + 0.5 - 0.25);
    const smallFaceScore = clamp01(Math.log10((avgFaceArea + 1e-24) / (meanArea + 1e-24)) / 3 + 0.5 - 0.2);

    const dihedralNorm = clamp01(maxDihedral[v] / (Math.PI * 0.75));
    const normalNorm = clamp01(normalVar / 1.0);
    const curve = clamp01(0.45 * normalNorm + 0.45 * dihedralNorm + 0.1 * smallFaceScore);
    curvature[v] = curve;

    const sharp = dihedralNorm > 0.35 ? dihedralNorm : 0;
    const cavity = clamp01(Math.max(concave[v], convex[v]) / (Math.PI * 0.5));
    const feat = clamp01(
      0.4 * normalNorm + 0.3 * dihedralNorm + 0.15 * sharp + 0.1 * cavity + 0.05 * smallFaceScore,
    );
    feature[v] = feat;

    // Estrutura fina: arestas muito curtas + curvatura alta + faces pequenas.
    const thinScore = clamp01(
      0.5 * clamp01((avgEdgeLength / (meanEdge + 1e-18) - 1) / 3) +
      0.3 * curve +
      0.2 * smallFaceScore,
    );
    thin[v] = thinScore > 0.45 ? thinScore : thinScore * 0.5;

    void densityScore;
  }

  // --- Silhueta: borda + arestas sharp com 1 vizinho + alta curvatura isolada ---
  for (const [key, count] of edgeCounts) {
    if (count !== 1) continue;
    const sep = key.indexOf(':');
    const a = Number(key.slice(0, sep));
    const b = Number(key.slice(sep + 1));
    if (a >= 0 && a < vertexCount) silhouette[a] = Math.max(silhouette[a], 0.9);
    if (b >= 0 && b < vertexCount) silhouette[b] = Math.max(silhouette[b], 0.9);
  }
  for (let v = 0; v < vertexCount; v += 1) {
    if (maxDihedral[v] > Math.PI * 0.4) silhouette[v] = Math.max(silhouette[v], 0.65);
    else if (curvature[v] > 0.75 && feature[v] > 0.6) silhouette[v] = Math.max(silhouette[v], 0.4);
  }

  // --- Classificação + feature lock ---
  for (let v = 0; v < vertexCount; v += 1) {
    const c = curvature[v];
    const f = feature[v];
    const t = thin[v];
    const s = silhouette[v];
    const critical = f > 0.72 || (c > 0.8 && f > 0.55) || t > 0.8 || s > 0.85;
    const micro = !critical && (f > 0.5 || c > 0.62 || t > 0.6);
    const alta = !critical && !micro && (c > 0.38 || f > 0.32);
    const curva = !critical && !micro && !alta && (c > 0.14 || f > 0.14);
    region[v] = critical
      ? RegionClass.FeatureCritica
      : micro
        ? RegionClass.MicroDetalhe
        : alta
          ? RegionClass.AltaCurvatura
          : curva
            ? RegionClass.Curva
            : RegionClass.Plana;
    locked[v] = critical ? 1 : 0;
  }

  return { curvature, feature, thin, silhouette, region, locked, avgEdgeLength, avgFaceArea, diagonal };
}

/** Multiplicador de custo: quanto maior a importância, mais caro colapsar. */
export function importanceMultiplier(map: ComplexityMap, vertex: number, quality: string): number {
  const c = map.curvature[vertex] ?? 0;
  const f = map.feature[vertex] ?? 0;
  const t = map.thin[vertex] ?? 0;
  const s = map.silhouette[vertex] ?? 0;
  const r = map.region[vertex] ?? RegionClass.Plana;
  const base = quality === 'ultra' ? 9 : quality === 'high' ? 5 : quality === 'medium' ? 2.6 : 1.4;
  const thinBoost = quality === 'ultra' ? 8 : quality === 'high' ? 5 : 3;
  let mult = 1 + base * (0.55 * f + 0.35 * c) + thinBoost * t * 0.6 + 2.2 * s;
  if (r === RegionClass.FeatureCritica) mult *= quality === 'low' ? 6 : 14;
  else if (r === RegionClass.MicroDetalhe) mult *= quality === 'low' ? 2.5 : 5;
  else if (r === RegionClass.AltaCurvatura) mult *= quality === 'low' ? 1.5 : 2.4;
  return mult;
}
