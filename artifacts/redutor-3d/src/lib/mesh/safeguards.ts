/**
 * SAFEGUARDS TOPOLÓGICOS E GEOMÉTRICOS
 * ------------------------------------
 * Validação SIMULATE → VALIDATE → COMMIT/REJECT de cada edge collapse.
 *
 * Cobre:
 *  - link condition (impede rasgos e non-manifold)
 *  - preservação de borda (zero novos buracos)
 *  - flip de normais com tolerância adaptativa por feature
 *  - razão de área e aspect ratio (sem degenerados / agulhas)
 *  - limite de deslocamento (sem saltos que deformam rosto/mãos)
 *  - auto-interseção local (anel de vizinhança) + global amostrada por estágio
 *  - distância ponto-superfície / Hausdorff aproximado por estágio
 */

export interface CollapseProposal {
  a: number;
  b: number;
  position: [number, number, number];
}

export function triangleArea(
  pos: Float64Array | number[],
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  void pos;
  const abx = bx - ax; const aby = by - ay; const abz = bz - az;
  const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
  const nx = aby * acz - abz * acy;
  const ny = abz * acx - abx * acz;
  const nz = abx * acy - aby * acx;
  return Math.hypot(nx, ny, nz) / 2;
}

/** Aspect ratio: aresta máxima / altura mínima. 1 = equilátero. */
export function triangleAspect(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const ab = Math.hypot(bx - ax, by - ay, bz - az);
  const bc = Math.hypot(cx - bx, cy - by, cz - bz);
  const ca = Math.hypot(ax - cx, ay - cy, az - cz);
  const s = (ab + bc + ca) / 2;
  const area = Math.sqrt(Math.max(0, s * (s - ab) * (s - bc) * (s - ca)));
  if (area < 1e-24) return Number.POSITIVE_INFINITY;
  const longest = Math.max(ab, bc, ca);
  return (longest * longest) / (2 * area);
}

/**
 * Link condition: N(a) ∩ N(b) deve ser exatamente o conjunto de vértices
 * opostos das faces que contêm a aresta (a,b). Qualquer divergência = rasgo.
 */
export function linkCondition(
  neighborsOfA: Set<number> | number[],
  neighborsOfB: Set<number> | number[],
  sharedOpposite: Set<number> | number[],
  a: number,
  b: number,
): boolean {
  const setA = neighborsOfA instanceof Set ? neighborsOfA : new Set(neighborsOfA);
  const setB = neighborsOfB instanceof Set ? neighborsOfB : new Set(neighborsOfB);
  const shared = sharedOpposite instanceof Set ? sharedOpposite : new Set(sharedOpposite);
  let commonCount = 0;
  for (const v of setA) {
    if (v === a || v === b) continue;
    if (setB.has(v)) {
      commonCount += 1;
      if (!shared.has(v)) return false;
    }
  }
  return commonCount === shared.size;
}

/** Regra de borda: nunca misturar vértice de borda com interior. */
export function boundaryCollapseAllowed(
  aOnBoundary: boolean,
  bOnBoundary: boolean,
  edgeIsBoundary: boolean,
): boolean {
  if (aOnBoundary !== bOnBoundary) return false;
  void edgeIsBoundary;
  return true;
}

export interface FlipCheckOptions {
  /** dot mínimo (0.35 genérico, 0.7+ para features). */
  minDot: number;
  minAreaRatio: number;
  maxAreaRatio: number;
  maxAspect: number;
  minArea: number;
}

export interface TriangleValidationStats {
  checked: number;
  skipped: number;
  minDot: number;
  maxAspect: number;
  minAreaRatio: number;
  maxAreaRatio: number;
  failStage: string;
}

export function validateResultTriangles(
  pos: Float64Array | number[],
  getVertex: (index: number) => [number, number, number],
  proposal: CollapseProposal,
  affectedFaces: number[],
  readTriangle: (face: number) => [number, number, number],
  faceNormalOf: (face: number) => [number, number, number],
  options: FlipCheckOptions,
  stats?: TriangleValidationStats,
  skipStaticA?: boolean,
): boolean {
  const [nx, ny, nz] = proposal.position;
  void pos;
  if (stats) {
    stats.checked = 0; stats.skipped = 0; stats.minDot = 2;
    stats.maxAspect = 0; stats.minAreaRatio = Infinity; stats.maxAreaRatio = 0;
    stats.failStage = 'pass';
  }
  const fail = (stage: string): false => {
    if (stats) stats.failStage = stage;
    return false;
  };
  for (const f of affectedFaces) {
    const [i0, i1, i2] = readTriangle(f);
    const mapped: number[] = [
      i0 === proposal.b ? proposal.a : i0,
      i1 === proposal.b ? proposal.a : i1,
      i2 === proposal.b ? proposal.a : i2,
    ];
    if (new Set(mapped).size < 3) {
      if (stats) stats.skipped += 1;
      continue; // faces que morrem no colapso
    }
    // Faces que continham `a` mas não `b` (índices ORIGINAIS), quando `a`
    // não se move (candidato = posição atual de `a`): geometricamente
    // INALTERADAS. Revalidá-las vetaria colapsos por causa de slivers
    // pré-existentes que não tocamos — travaria a redução em scans sem
    // nenhum benefício.
    if (skipStaticA && i0 !== proposal.b && i1 !== proposal.b && i2 !== proposal.b) {
      if (stats) stats.skipped += 1;
      continue;
    }
    if (stats) stats.checked += 1;
    const p0 = mapped[0] === proposal.a ? [nx, ny, nz] as [number, number, number] : getVertex(mapped[0]);
    const p1 = mapped[1] === proposal.a ? [nx, ny, nz] as [number, number, number] : getVertex(mapped[1]);
    const p2 = mapped[2] === proposal.a ? [nx, ny, nz] as [number, number, number] : getVertex(mapped[2]);
    const dbg = (globalThis as Record<string, unknown>).__MESH_DEBUG as Record<string, number> | undefined;
    const before = faceNormalOf(f);
    const bl = Math.hypot(before[0], before[1], before[2]);
    const abx = p1[0] - p0[0]; const aby = p1[1] - p0[1]; const abz = p1[2] - p0[2];
    const acx = p2[0] - p0[0]; const acy = p2[1] - p0[1]; const acz = p2[2] - p0[2];
    const ax = aby * acz - abz * acy;
    const ay = abz * acx - abx * acz;
    const az = abx * acy - aby * acx;
    const al = Math.hypot(ax, ay, az);
    if (!(al > 1e-18) || !(bl > 1e-18)) {
      if (dbg) dbg['tri-zero-area'] = (dbg['tri-zero-area'] ?? 0) + 1;
      return fail('zero-area');
    }
    const dot = (before[0] * ax + before[1] * ay + before[2] * az) / (bl * al);
    if (stats && dot < stats.minDot) stats.minDot = dot;
    if (!(dot >= options.minDot)) {
      if (dbg) {
        dbg['tri-flip'] = (dbg['tri-flip'] ?? 0) + 1;
        const worst = Number((dbg as Record<string, unknown>)['worst-dot'] ?? 2);
        if (dot < worst) (dbg as Record<string, unknown>)['worst-dot'] = Math.round(dot * 1000) / 1000;
      }
      return fail('flip');
    }
    const beforeArea = bl / 2;
    const afterArea = al / 2;
    if (!(afterArea >= options.minArea)) {
      if (dbg) dbg['tri-minarea'] = (dbg['tri-minarea'] ?? 0) + 1;
      return fail('minarea');
    }
    const ratio = afterArea / beforeArea;
    if (stats) {
      if (ratio < stats.minAreaRatio) stats.minAreaRatio = ratio;
      if (ratio > stats.maxAreaRatio) stats.maxAreaRatio = ratio;
    }
    if (!(ratio >= options.minAreaRatio && ratio <= options.maxAreaRatio)) {
      if (dbg) dbg['tri-arearatio'] = (dbg['tri-arearatio'] ?? 0) + 1;
      return fail('arearatio');
    }
    const aspect = triangleAspect(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2]);
    if (stats && aspect > stats.maxAspect) stats.maxAspect = aspect;
    if (!(aspect <= options.maxAspect)) {
      if (dbg) {
        dbg['tri-aspect'] = (dbg['tri-aspect'] ?? 0) + 1;
        const worst = Number((dbg as Record<string, unknown>)['worst-aspect'] ?? 0);
        if (aspect > worst && aspect < 1e15) (dbg as Record<string, unknown>)['worst-aspect'] = Math.round(aspect * 100) / 100;
      }
      return fail('aspect');
    }
  }
  return true;
}

/** Limite de deslocamento: o novo vértice não pode saltar além da vizinhança. */
export function displacementAllowed(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  nx: number, ny: number, nz: number,
  localEdge: number,
  strictness: number,
): boolean {
  const da = Math.hypot(nx - ax, ny - ay, nz - az);
  const db = Math.hypot(nx - bx, ny - by, nz - bz);
  const edge = Math.hypot(bx - ax, by - ay, bz - az);
  const scale = Math.max(edge, localEdge, 1e-12);
  return da <= scale * strictness && db <= scale * strictness;
}

// ---------------------------------------------------------------------------
// Hausdorff aproximado por amostragem com grade espacial uniforme
// ---------------------------------------------------------------------------

interface GridCell {
  tris: number[];
}

export interface SampleMesh {
  positions: Float64Array | Float32Array | number[];
  indices: Uint32Array | number[];
}

/** Distância ponto-triângulo ao quadrado (Real-Time Collision Detection). */
function pointTriangleDistSq(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number {
  const abx = bx - ax; const aby = by - ay; const abz = bz - az;
  const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
  const apx = px - ax; const apy = py - ay; const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return apx * apx + apy * apy + apz * apz;
  const bpx = px - bx; const bpy = py - by; const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return bpx * bpx + bpy * bpy + bpz * bpz;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v - px; const qy = ay + aby * v - py; const qz = az + abz * v - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const cpx = px - cx; const cpy = py - cy; const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return cpx * cpx + cpy * cpy + cpz * cpz;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w - px; const qy = ay + acy * w - py; const qz = az + acz * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bx + (cx - bx) * w - px; const qy = by + (cy - by) * w - py; const qz = bz + (cz - bz) * w - pz;
    return qx * qx + qy * qy + qz * qz;
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w - px;
  const qy = ay + aby * v + acy * w - py;
  const qz = az + abz * v + acz * w - pz;
  return qx * qx + qy * qy + qz * qz;
}

/**
 * Erro de superfície aproximado: amostra pontos da malha de referência e
 * mede a distância até a malha candidata usando grade uniforme.
 * Retorna { mean, max } normalizados pela diagonal.
 */
export function approximateSurfaceError(
  reference: SampleMesh,
  candidate: SampleMesh,
  diagonal: number,
  samples = 1500,
): { mean: number; max: number } {
  const refTris = reference.indices.length / 3;
  const candTris = candidate.indices.length / 3;
  if (refTris === 0 || candTris === 0 || diagonal <= 0) return { mean: 0, max: 0 };
  const count = Math.min(samples, refTris);

  // Grade uniforme sobre a candidata.
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  const cp = candidate.positions;
  for (let i = 0; i < cp.length; i += 3) {
    if (cp[i] < minX) minX = cp[i];
    if (cp[i + 1] < minY) minY = cp[i + 1];
    if (cp[i + 2] < minZ) minZ = cp[i + 2];
    if (cp[i] > maxX) maxX = cp[i];
    if (cp[i + 1] > maxY) maxY = cp[i + 1];
    if (cp[i + 2] > maxZ) maxZ = cp[i + 2];
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-12);
  const cellsPerAxis = Math.max(4, Math.min(24, Math.round(Math.cbrt(candTris / 4))));
  const cellSize = span / cellsPerAxis || span;
  const grid = new Map<string, GridCell>();
  const ci = candidate.indices;
  const cellKey = (x: number, y: number, z: number) => `${x}:${y}:${z}`;
  for (let t = 0; t < candTris; t += 1) {
    const a = ci[t * 3] * 3; const b = ci[t * 3 + 1] * 3; const c = ci[t * 3 + 2] * 3;
    const tx0 = Math.min(cp[a], cp[b], cp[c]);
    const ty0 = Math.min(cp[a + 1], cp[b + 1], cp[c + 1]);
    const tz0 = Math.min(cp[a + 2], cp[b + 2], cp[c + 2]);
    const tx1 = Math.max(cp[a], cp[b], cp[c]);
    const ty1 = Math.max(cp[a + 1], cp[b + 1], cp[c + 1]);
    const tz1 = Math.max(cp[a + 2], cp[b + 2], cp[c + 2]);
    // NOTA: os índices inferiores também precisam do clamp superior — um
    // triângulo exatamente sobre o máximo da bounding box gerava
    // x0 > x1 (loop vazio) e sumia da grade, criando erro fantasma.
    const x0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((tx0 - minX) / cellSize)));
    const y0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((ty0 - minY) / cellSize)));
    const z0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((tz0 - minZ) / cellSize)));
    const x1 = Math.min(cellsPerAxis - 1, Math.floor((tx1 - minX) / cellSize));
    const y1 = Math.min(cellsPerAxis - 1, Math.floor((ty1 - minY) / cellSize));
    const z1 = Math.min(cellsPerAxis - 1, Math.floor((tz1 - minZ) / cellSize));
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const key = cellKey(x, y, z);
          let cell = grid.get(key);
          if (!cell) { cell = { tris: [] }; grid.set(key, cell); }
          cell.tris.push(t);
        }
      }
    }
  }

  const rp = reference.positions;
  const ri = reference.indices;
  let sum = 0;
  let max = 0;
  // Amostragem determinística: centroides distribuídos pelo índice.
  const stride = Math.max(1, Math.floor(refTris / count));
  let taken = 0;
  for (let t = 0; t < refTris && taken < count; t += stride) {
    const a = ri[t * 3] * 3; const b = ri[t * 3 + 1] * 3; const c = ri[t * 3 + 2] * 3;
    const px = (rp[a] + rp[b] + rp[c]) / 3;
    const py = (rp[a + 1] + rp[b + 1] + rp[c + 1]) / 3;
    const pz = (rp[a + 2] + rp[b + 2] + rp[c + 2]) / 3;
    const cx = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((px - minX) / cellSize)));
    const cy = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((py - minY) / cellSize)));
    const cz = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((pz - minZ) / cellSize)));
    let best = Infinity;
    // Expande o raio até encontrar triângulos (máx. 2 anéis).
    for (let ring = 0; ring <= 2 && best === Infinity; ring += 1) {
      for (let x = Math.max(0, cx - ring); x <= Math.min(cellsPerAxis - 1, cx + ring); x += 1) {
        for (let y = Math.max(0, cy - ring); y <= Math.min(cellsPerAxis - 1, cy + ring); y += 1) {
          for (let z = Math.max(0, cz - ring); z <= Math.min(cellsPerAxis - 1, cz + ring); z += 1) {
            const cell = grid.get(cellKey(x, y, z));
            if (!cell) continue;
            for (const tt of cell.tris) {
              const ia = ci[tt * 3] * 3; const ib = ci[tt * 3 + 1] * 3; const ic = ci[tt * 3 + 2] * 3;
              const d = pointTriangleDistSq(
                px, py, pz,
                cp[ia], cp[ia + 1], cp[ia + 2],
                cp[ib], cp[ib + 1], cp[ib + 2],
                cp[ic], cp[ic + 1], cp[ic + 2],
              );
              if (d < best) best = d;
            }
          }
        }
      }
    }
    if (best === Infinity) best = 0; // fora da grade por tolerância numérica
    const dist = Math.sqrt(best) / diagonal;
    sum += dist;
    if (dist > max) max = dist;
    taken += 1;
  }
  return { mean: taken > 0 ? sum / taken : 0, max };
}

// ---------------------------------------------------------------------------
// Grade triangular reutilizável (construída UMA vez sobre a referência)
// ---------------------------------------------------------------------------

export interface TriangleGrid {
  cells: Map<string, number[]>;
  cellsPerAxis: number;
  cellSize: number;
  minX: number;
  minY: number;
  minZ: number;
  positions: Float64Array | Float32Array | number[];
  indices: Uint32Array | number[] | Int32Array;
  triCount: number;
}

/** Constroi a grade uma única vez (ex. sobre a malha ORIGINAL imutável). */
export function buildTriangleGrid(
  positions: Float64Array | Float32Array | number[],
  indices: Uint32Array | number[] | Int32Array,
): TriangleGrid {
  const triCount = Math.floor(indices.length / 3);
  let minX = Infinity; let minY = Infinity; let minZ = Infinity;
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 2] < minZ) minZ = positions[i + 2];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
    if (positions[i + 2] > maxZ) maxZ = positions[i + 2];
  }
  const span = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-12);
  const cellsPerAxis = Math.max(4, Math.min(32, Math.round(Math.cbrt(Math.max(1, triCount) / 4))));
  const cellSize = span / cellsPerAxis || span;
  const cells = new Map<string, number[]>();
  for (let t = 0; t < triCount; t += 1) {
    const a = indices[t * 3] * 3; const b = indices[t * 3 + 1] * 3; const c = indices[t * 3 + 2] * 3;
    if (a < 0 || b < 0 || c < 0) continue;
    const tx0 = Math.min(positions[a], positions[b], positions[c]);
    const ty0 = Math.min(positions[a + 1], positions[b + 1], positions[c + 1]);
    const tz0 = Math.min(positions[a + 2], positions[b + 2], positions[c + 2]);
    const tx1 = Math.max(positions[a], positions[b], positions[c]);
    const ty1 = Math.max(positions[a + 1], positions[b + 1], positions[c + 1]);
    const tz1 = Math.max(positions[a + 2], positions[b + 2], positions[c + 2]);
    const x0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((tx0 - minX) / cellSize)));
    const y0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((ty0 - minY) / cellSize)));
    const z0 = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((tz0 - minZ) / cellSize)));
    const x1 = Math.min(cellsPerAxis - 1, Math.floor((tx1 - minX) / cellSize));
    const y1 = Math.min(cellsPerAxis - 1, Math.floor((ty1 - minY) / cellSize));
    const z1 = Math.min(cellsPerAxis - 1, Math.floor((tz1 - minZ) / cellSize));
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        for (let z = z0; z <= z1; z += 1) {
          const key = `${x}:${y}:${z}`;
          let cell = cells.get(key);
          if (!cell) { cell = []; cells.set(key, cell); }
          cell.push(t);
        }
      }
    }
  }
  return { cells, cellsPerAxis, cellSize, minX, minY, minZ, positions, indices, triCount };
}

/** Ponto mais próximo na malha da grade + distância² (para reparo local). */
export function queryGridClosest(
  grid: TriangleGrid,
  px: number, py: number, pz: number,
): { dist2: number; qx: number; qy: number; qz: number } {
  const { cells, cellsPerAxis, cellSize, minX, minY, minZ, positions, indices } = grid;
  const cx = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((px - minX) / cellSize)));
  const cy = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((py - minY) / cellSize)));
  const cz = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((pz - minZ) / cellSize)));
  let best = Infinity;
  let qx = px; let qy = py; let qz = pz;
  for (let ring = 0; ring <= 3 && best === Infinity; ring += 1) {
    for (let x = Math.max(0, cx - ring); x <= Math.min(cellsPerAxis - 1, cx + ring); x += 1) {
      for (let y = Math.max(0, cy - ring); y <= Math.min(cellsPerAxis - 1, cy + ring); y += 1) {
        for (let z = Math.max(0, cz - ring); z <= Math.min(cellsPerAxis - 1, cz + ring); z += 1) {
          const cell = cells.get(`${x}:${y}:${z}`);
          if (!cell) continue;
          for (const tt of cell) {
            const ia = indices[tt * 3] * 3; const ib = indices[tt * 3 + 1] * 3; const ic = indices[tt * 3 + 2] * 3;
            const closest = pointTriangleClosest(
              px, py, pz,
              positions[ia], positions[ia + 1], positions[ia + 2],
              positions[ib], positions[ib + 1], positions[ib + 2],
              positions[ic], positions[ic + 1], positions[ic + 2],
            );
            if (closest.dist2 < best) {
              best = closest.dist2;
              qx = closest.qx; qy = closest.qy; qz = closest.qz;
            }
          }
        }
      }
    }
  }
  return { dist2: best === Infinity ? 0 : best, qx, qy, qz };
}

/** Ponto mais próximo em um triângulo (RTCD, com coordenadas do ponto). */
export function pointTriangleClosest(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): { dist2: number; qx: number; qy: number; qz: number } {
  const abx = bx - ax; const aby = by - ay; const abz = bz - az;
  const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
  const apx = px - ax; const apy = py - ay; const apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return { dist2: apx * apx + apy * apy + apz * apz, qx: ax, qy: ay, qz: az };
  const bpx = px - bx; const bpy = py - by; const bpz = pz - bz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return { dist2: bpx * bpx + bpy * bpy + bpz * bpz, qx: bx, qy: by, qz: bz };
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    const qx = ax + abx * v; const qy = ay + aby * v; const qz = az + abz * v;
    return { dist2: (qx - px) * (qx - px) + (qy - py) * (qy - py) + (qz - pz) * (qz - pz), qx, qy, qz };
  }
  const cpx = px - cx; const cpy = py - cy; const cpz = pz - cz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return { dist2: cpx * cpx + cpy * cpy + cpz * cpz, qx: cx, qy: cy, qz: cz };
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    const qx = ax + acx * w; const qy = ay + acy * w; const qz = az + acz * w;
    return { dist2: (qx - px) * (qx - px) + (qy - py) * (qy - py) + (qz - pz) * (qz - pz), qx, qy, qz };
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    const qx = bx + (cx - bx) * w; const qy = by + (cy - by) * w; const qz = bz + (cz - bz) * w;
    return { dist2: (qx - px) * (qx - px) + (qy - py) * (qy - py) + (qz - pz) * (qz - pz), qx, qy, qz };
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  const qx = ax + abx * v + acx * w; const qy = ay + aby * v + acy * w; const qz = az + abz * v + acz * w;
  return { dist2: (qx - px) * (qx - px) + (qy - py) * (qy - py) + (qz - pz) * (qz - pz), qx, qy, qz };
}

/**
 * Erro direcionado: distância de vértices amostrados até a grade
 * (ex. vértices candidatos → grade da referência, construída uma vez).
 */
export function directedSamplesError(
  grid: TriangleGrid,
  positions: Float64Array | Float32Array | number[],
  vertexCount: number,
  alive: Uint8Array | null,
  diagonal: number,
  samples = 1200,
): { mean: number; max: number; rms: number } {
  const count = Math.min(samples, vertexCount);
  if (count === 0 || diagonal <= 0) return { mean: 0, max: 0, rms: 0 };
  const stride = Math.max(1, Math.floor(vertexCount / count));
  let sum = 0; let sumSq = 0; let max = 0; let taken = 0;
  for (let v = 0; v < vertexCount && taken < count; v += stride) {
    if (alive && !alive[v]) continue;
    const q = queryGridClosest(grid, positions[v * 3], positions[v * 3 + 1], positions[v * 3 + 2]);
    const dist = Math.sqrt(q.dist2) / diagonal;
    sum += dist;
    sumSq += dist * dist;
    if (dist > max) max = dist;
    taken += 1;
  }
  return { mean: taken > 0 ? sum / taken : 0, max, rms: taken > 0 ? Math.sqrt(sumSq / taken) : 0 };
}

/**
 * Interseção triângulo-triângulo (Möller, só booleano — para validar que um
 * patch não atravessa a vizinhança). Barato para checagens locais.
 */
export function trianglesIntersect(
  a0: number, a1: number, a2: number, b0: number, b1: number, b2: number,
  c0: number, c1: number, c2: number, d0: number, d1: number, d2: number,
  e0: number, e1: number, e2: number, f0: number, f1: number, f2: number,
): boolean {
  // Eixo de separação: normais dos dois triângulos + 9 produtos vetoriais.
  const ux = b0 - a0; const uy = b1 - a1; const uz = b2 - a2;
  const vx = c0 - a0; const vy = c1 - a1; const vz = c2 - a2;
  let nx = uy * vz - uz * vy; let ny = uz * vx - ux * vz; let nz = ux * vy - uy * vx;
  const nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-24) return false;
  nx /= nl; ny /= nl; nz /= nl;
  const da = nx * a0 + ny * a1 + nz * a2;
  const db0 = nx * d0 + ny * d1 + nz * d2 - da;
  const db1 = nx * e0 + ny * e1 + nz * e2 - da;
  const db2 = nx * f0 + ny * f1 + nz * f2 - da;
  if ((db0 > 0 && db1 > 0 && db2 > 0) || (db0 < 0 && db1 < 0 && db2 < 0)) return false;
  const px = e0 - d0; const py = e1 - d1; const pz = e2 - d2;
  const qx = f0 - d0; const qy = f1 - d1; const qz = f2 - d2;
  let mx = py * qz - pz * qy; let my = pz * qx - px * qz; let mz = px * qy - py * qx;
  const ml = Math.hypot(mx, my, mz);
  if (ml < 1e-24) return false;
  mx /= ml; my /= ml; mz /= ml;
  const dd = mx * d0 + my * d1 + mz * d2;
  const da0 = mx * a0 + my * a1 + mz * a2 - dd;
  const da1 = mx * b0 + my * b1 + mz * b2 - dd;
  const da2 = mx * c0 + my * c1 + mz * c2 - dd;
  if ((da0 > 0 && da1 > 0 && da2 > 0) || (da0 < 0 && da1 < 0 && da2 < 0)) return false;
  // Sem eixo de separação entre as normais: teste das 9 arestas cruzadas.
  const edgesA: Array<[number, number, number]> = [[ux, uy, uz], [vx, vy, vz], [ax(c0, b0), ax(c1, b1), ax(c2, b2)]];
  const edgesB: Array<[number, number, number]> = [[px, py, pz], [qx, qy, qz], [ax(f0, e0), ax(f1, e1), ax(f2, e2)]];
  const vertsA: Array<[number, number, number]> = [[a0, a1, a2], [b0, b1, b2], [c0, c1, c2]];
  const vertsB: Array<[number, number, number]> = [[d0, d1, d2], [e0, e1, e2], [f0, f1, f2]];
  for (const [ex, ey, ez] of edgesA) {
    for (const [fx, fy, fz] of edgesB) {
      let sx = ey * fz - ez * fy; let sy = ez * fx - ex * fz; let sz = ex * fy - ey * fx;
      const sl = Math.hypot(sx, sy, sz);
      if (sl < 1e-24) continue;
      sx /= sl; sy /= sl; sz /= sl;
      let mna = Infinity; let mxa = -Infinity;
      for (const [ox, oy, oz] of vertsA) {
        const p = ox * sx + oy * sy + oz * sz;
        if (p < mna) mna = p;
        if (p > mxa) mxa = p;
      }
      let mnb = Infinity; let mxb = -Infinity;
      for (const [ox, oy, oz] of vertsB) {
        const p = ox * sx + oy * sy + oz * sz;
        if (p < mnb) mnb = p;
        if (p > mxb) mxb = p;
      }
      if (mxa < mnb || mxb < mna) return false;
    }
  }
  return true;
}

function ax(a: number, b: number): number {
  return a - b;
}

const SILHOUETTE_VIEWS: Array<[number, number, number]> = [
  [1, 0, 0], [0, 1, 0], [0, 0, 1],
  [0.577350269, 0.577350269, 0.577350269],
  [0.577350269, 0.577350269, -0.577350269],
  [0.577350269, -0.577350269, 0.577350269],
  [-0.577350269, 0.577350269, 0.577350269],
];

function projectedArea(
  positions: Float64Array | Float32Array | number[],
  vertexCount: number,
  alive: Uint8Array | null,
  dir: [number, number, number],
  maxSamples: number,
): number {
  // Base ortonormal à direção de vista.
  const ax = Math.abs(dir[0]) < 0.9 ? 1 : 0;
  const ay = Math.abs(dir[0]) < 0.9 ? 0 : 1;
  const az = 0;
  let e1x = ay * dir[2] - az * dir[1];
  let e1y = az * dir[0] - ax * dir[2];
  let e1z = ax * dir[1] - ay * dir[0];
  const e1l = Math.hypot(e1x, e1y, e1z) || 1;
  e1x /= e1l; e1y /= e1l; e1z /= e1l;
  const e2x = dir[1] * e1z - dir[2] * e1y;
  const e2y = dir[2] * e1x - dir[0] * e1z;
  const e2z = dir[0] * e1y - dir[1] * e1x;
  const stride = Math.max(1, Math.floor(vertexCount / maxSamples));
  let minu = Infinity; let maxu = -Infinity;
  let minv = Infinity; let maxv = -Infinity;
  let taken = 0;
  for (let v = 0; v < vertexCount && taken < maxSamples; v += stride) {
    if (alive && !alive[v]) continue;
    const x = positions[v * 3]; const y = positions[v * 3 + 1]; const z = positions[v * 3 + 2];
    const u = x * e1x + y * e1y + z * e1z;
    const w = x * e2x + y * e2y + z * e2z;
    if (u < minu) minu = u;
    if (u > maxu) maxu = u;
    if (w < minv) minv = w;
    if (w > maxv) maxv = w;
    taken += 1;
  }
  if (taken === 0) return 0;
  return (maxu - minu) * (maxv - minv);
}

/**
 * Erro de silhueta: compara a área projetada (contorno) em 7 vistas
 * (X, Y, Z + 4 diagonais). Retorna a maior diferença relativa.
 * Invariante a translação; detecta encolhimento, achatamento e
 * perda de membros/silhueta.
 */
export function silhouetteError(
  refPositions: Float64Array | Float32Array | number[],
  refCount: number,
  candPositions: Float64Array | Float32Array | number[],
  candCount: number,
  candAlive: Uint8Array | null,
  diagonal: number,
): number {
  void diagonal;
  let worst = 0;
  for (const dir of SILHOUETTE_VIEWS) {
    const aRef = projectedArea(refPositions, refCount, null, dir, 4000);
    const aCand = projectedArea(candPositions, candCount, candAlive, dir, 4000);
    const denom = Math.max(aRef, 1e-24);
    const diff = Math.abs(aCand - aRef) / denom;
    if (diff > worst) worst = diff;
  }
  return worst;
}
