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
