/**
 * POST-COMPRESSION SURFACE RECONSTRUCTION
 * (MESH REFINEMENT & SURFACE HEALING ENGINE)
 * -------------------------------------------
 * Etapa obrigatória após a redução, antes da validação final:
 *
 *   DETECTAR → CLASSIFICAR → LOCALIZAR NO ORIGINAL → RECONSTRUIR →
 *   PROJETAR → CONECTAR → SUAVIZAR TRANSIÇÃO → VALIDAR → ACEITAR/ROLLBACK.
 *
 * Princípios inegociáveis:
 * - ORIGINAL_REFERENCE_MESH é ground truth (via grade espacial estática).
 * - NUNCA inventar geometria: todo vértice novo é PROJETADO no original.
 * - NUNCA tampa plana genérica: o centroide do patch é projetado na
 *   superfície original (INTELLIGENT CURVED CAP guiado pelo original).
 * - Buraco ORIGINAL ≠ artefato: só loops NOVOS (interiores na referência)
 *   entram em reconstrução.
 * - Orçamento de faces (REPAIR FACE BUDGET): poucas faces por defeito,
 *   teto global por execução — nunca compensar com excesso de faces.
 * - Loops grandes (>10 arestas) são RECUSADOS (rollback da estratégia,
 *   não patch heroico): economia e honestidade acima de heroísmo.
 * - Rollback por defeito: inverse-ops log (só adicionamos vértices/faces,
 *   nunca movemos o existente → desfazer é trivial e exato).
 */
import { pointTriangleClosest, triangleAspect, trianglesIntersect, type TriangleGrid } from './safeguards';

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

export interface HealingStats {
  defectsFound: number;
  defectsRepaired: number;
  defectsRolledBack: number;
  facesAdded: number;
  timeMs: number;
  log: HealingLogEntry[];
}

/** Operações que o engine cede ao healing (sem expor estruturas internas). */
export interface HealingMesh {
  pos: Float64Array;
  tri: Int32Array;
  triAlive: Uint8Array;
  vertAlive: Uint8Array;
  vertexCount: number;
  vertFaces: Array<number[]>;
  faceNormals: Float64Array;
  liveEdges: Map<string, number>;
  allocVertex(): number;
  allocFace(): number;
  releaseVertex(v: number): void;
  releaseFace(f: number): void;
  resetQuadric(v: number): void;
  inheritRegion(v: number, neighbors: number[]): void;
  bumpVertex(v: number): void;
  addEdge(a: number, b: number, f: number): void;
  removeEdge(a: number, b: number, f: number): void;
}

export interface HealingReference {
  grid: TriangleGrid;
  diagonal: number;
  /** Bordas ORIGINAIS (qualquer outra borda viva é artefato novo). */
  refBoundary: Set<string>;
}

export interface HealingOptions {
  maxDefects: number;
  /** Teto de faces NOVAS por execução (reparo econômico). */
  faceBudget: number;
  /** Tamanho máximo de loop tratável (arestas). Maior → recusa. */
  maxLoopEdges: number;
}

function edgeKeyOf(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/**
 * Arestas de borda que NÃO existiam na referência = artefatos.
 * (Colapsos nunca fecham buracos — só removem faces — então borda nova
 * é sempre dano; borda original é preservada como está.)
 */
function findNewBoundaryEdges(mesh: HealingMesh, ref: HealingReference): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [key, count] of mesh.liveEdges) {
    if (count !== 1) continue;
    if (ref.refBoundary.has(key)) continue;
    const sep = key.indexOf(':');
    out.push([Number(key.slice(0, sep)), Number(key.slice(sep + 1))]);
  }
  return out;
}

/**
 * Extrai ciclos simples (loops fechados sem repetição) via DFS limitada.
 * Decompõe corretamente figura-8/pinch (cada lobo vira um loop) e recusa
 * traçados não-simples. Teto global de estados para nunca explodir.
 */
function traceLoops(
  edges: Array<[number, number]>,
  maxLen: number,
): { loops: number[][]; leftoverEdges: number } {
  const adj = new Map<number, number[]>();
  for (const [a, b] of edges) {
    if (!adj.has(a)) adj.set(a, []);
    if (!adj.has(b)) adj.set(b, []);
    adj.get(a)!.push(b);
    adj.get(b)!.push(a);
  }
  const used = new Set<string>();
  const loops: number[][] = [];
  let states = 0;
  const STATE_CAP = 40000;

  const findCycle = (start: number, first: number): number[] | null => {
    interface Frame { v: number; prev: number; idx: number }
    const path = [start, first];
    const onPath = new Set<number>([start, first]);
    const stack: Frame[] = [
      { v: start, prev: -1, idx: (adj.get(start) ?? []).indexOf(first) + 1 },
      { v: first, prev: start, idx: 0 },
    ];
    while (stack.length > 0) {
      if (++states > STATE_CAP) return null;
      const f = stack[stack.length - 1];
      const nbs = adj.get(f.v) ?? [];
      if (f.idx >= nbs.length) {
        stack.pop();
        path.pop();
        onPath.delete(f.v);
        continue;
      }
      const n = nbs[f.idx++];
      if (n === f.prev) continue;
      if (used.has(edgeKeyOf(f.v, n))) continue;
      if (n === start) {
        if (path.length >= 3 && path.length <= maxLen) return [...path];
        continue;
      }
      if (onPath.has(n)) continue;
      if (path.length + 1 > maxLen) continue;
      onPath.add(n);
      path.push(n);
      stack.push({ v: n, prev: f.v, idx: 0 });
    }
    return null;
  };

  for (const [a, neighbors] of adj) {
    for (const b of neighbors) {
      if (used.has(edgeKeyOf(a, b))) continue;
      const cycle = findCycle(a, b);
      if (!cycle) continue;
      for (let i = 0; i < cycle.length; i += 1) {
        used.add(edgeKeyOf(cycle[i], cycle[(i + 1) % cycle.length]));
      }
      loops.push(cycle);
    }
  }
  let leftover = 0;
  for (const [a, neighbors] of adj) {
    for (const b of neighbors) {
      if (!used.has(edgeKeyOf(a, b))) leftover += 1;
    }
  }
  return { loops: loops.slice(0, 64), leftoverEdges: Math.floor(leftover / 2) };
}

function loopStats(mesh: HealingMesh, loop: number[]): { center: [number, number, number]; area: number; perimeter: number } {
  let cx = 0; let cy = 0; let cz = 0;
  for (const v of loop) {
    cx += mesh.pos[v * 3]; cy += mesh.pos[v * 3 + 1]; cz += mesh.pos[v * 3 + 2];
  }
  cx /= loop.length; cy /= loop.length; cz /= loop.length;
  let area = 0;
  let perimeter = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]; const b = loop[(i + 1) % loop.length];
    const ax = mesh.pos[a * 3]; const ay = mesh.pos[a * 3 + 1]; const az = mesh.pos[a * 3 + 2];
    const bx = mesh.pos[b * 3]; const by = mesh.pos[b * 3 + 1]; const bz = mesh.pos[b * 3 + 2];
    perimeter += Math.hypot(bx - ax, by - ay, bz - az);
    // Área do fan (cx,cy,cz)→(a,b) como medida do buraco.
    const abx = bx - ax; const aby = by - ay; const abz = bz - az;
    const acx = cx - ax; const acy = cy - ay; const acz = cz - az;
    area += Math.hypot(aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx) / 2;
  }
  return { center: [cx, cy, cz], area, perimeter };
}

/** Ponto + normal da referência mais próximos (para projeção e orientação). */
function closestOnReference(
  grid: TriangleGrid,
  x: number, y: number, z: number,
): { dist2: number; qx: number; qy: number; qz: number; nx: number; ny: number; nz: number } {
  const { cells, cellsPerAxis, cellSize, minX, minY, minZ, positions, indices } = grid;
  const cx = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((x - minX) / cellSize)));
  const cy = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((y - minY) / cellSize)));
  const cz = Math.min(cellsPerAxis - 1, Math.max(0, Math.floor((z - minZ) / cellSize)));
  let best = Infinity;
  let qx = x; let qy = y; let qz = z;
  let nx = 0; let ny = 0; let nz = 1;
  for (let ring = 0; ring <= 3 && best === Infinity; ring += 1) {
    for (let ix = Math.max(0, cx - ring); ix <= Math.min(cellsPerAxis - 1, cx + ring); ix += 1) {
      for (let iy = Math.max(0, cy - ring); iy <= Math.min(cellsPerAxis - 1, cy + ring); iy += 1) {
        for (let iz = Math.max(0, cz - ring); iz <= Math.min(cellsPerAxis - 1, cz + ring); iz += 1) {
          const cell = cells.get(`${ix}:${iy}:${iz}`);
          if (!cell) continue;
          for (const tt of cell) {
            const ia = indices[tt * 3] * 3; const ib = indices[tt * 3 + 1] * 3; const ic = indices[tt * 3 + 2] * 3;
            const c = pointTriangleClosest(
              x, y, z,
              positions[ia], positions[ia + 1], positions[ia + 2],
              positions[ib], positions[ib + 1], positions[ib + 2],
              positions[ic], positions[ic + 1], positions[ic + 2],
            );
            if (c.dist2 < best) {
              best = c.dist2;
              qx = c.qx; qy = c.qy; qz = c.qz;
              const ex = positions[ib] - positions[ia]; const ey = positions[ib + 1] - positions[ia + 1]; const ez = positions[ib + 2] - positions[ia + 2];
              const fx = positions[ic] - positions[ia]; const fy = positions[ic + 1] - positions[ia + 1]; const fz = positions[ic + 2] - positions[ia + 2];
              nx = ey * fz - ez * fy; ny = ez * fx - ex * fz; nz = ex * fy - ey * fx;
              const l = Math.hypot(nx, ny, nz) || 1;
              nx /= l; ny /= l; nz /= l;
            }
          }
        }
      }
    }
  }
  return { dist2: best === Infinity ? 0 : best, qx, qy, qz, nx, ny, nz };
}

function newellNormal(mesh: HealingMesh, loop: number[]): [number, number, number] {
  let nx = 0; let ny = 0; let nz = 0;
  for (let i = 0; i < loop.length; i += 1) {
    const a = loop[i]; const b = loop[(i + 1) % loop.length];
    const ax = mesh.pos[a * 3]; const ay = mesh.pos[a * 3 + 1]; const az = mesh.pos[a * 3 + 2];
    const bx = mesh.pos[b * 3]; const by = mesh.pos[b * 3 + 1]; const bz = mesh.pos[b * 3 + 2];
    nx += (ay - by) * (az + bz);
    ny += (az - bz) * (ax + bx);
    nz += (ax - bx) * (ay + by);
  }
  const l = Math.hypot(nx, ny, nz) || 1;
  return [nx / l, ny / l, nz / l];
}

function faceNormalOfPositions(
  pos: Float64Array, a: number, b: number, c: number,
): [number, number, number] {
  const abx = pos[b * 3] - pos[a * 3]; const aby = pos[b * 3 + 1] - pos[a * 3 + 1]; const abz = pos[b * 3 + 2] - pos[a * 3 + 2];
  const acx = pos[c * 3] - pos[a * 3]; const acy = pos[c * 3 + 1] - pos[a * 3 + 1]; const acz = pos[c * 3 + 2] - pos[a * 3 + 2];
  return [aby * acz - abz * acy, abz * acx - abx * acz, abx * acy - aby * acx];
}

function aabbOverlap(
  pos: Float64Array,
  a: number, b: number, c: number,
  d: number, e: number, f: number,
): boolean {
  const minx = Math.min(pos[a * 3], pos[b * 3], pos[c * 3]);
  const maxx = Math.max(pos[a * 3], pos[b * 3], pos[c * 3]);
  if (Math.min(pos[d * 3], pos[e * 3], pos[f * 3]) > maxx) return false;
  if (Math.max(pos[d * 3], pos[e * 3], pos[f * 3]) < minx) return false;
  const miny = Math.min(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]);
  const maxy = Math.max(pos[a * 3 + 1], pos[b * 3 + 1], pos[c * 3 + 1]);
  if (Math.min(pos[d * 3 + 1], pos[e * 3 + 1], pos[f * 3 + 1]) > maxy) return false;
  if (Math.max(pos[d * 3 + 1], pos[e * 3 + 1], pos[f * 3 + 1]) < miny) return false;
  const minz = Math.min(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]);
  const maxz = Math.max(pos[a * 3 + 2], pos[b * 3 + 2], pos[c * 3 + 2]);
  if (Math.min(pos[d * 3 + 2], pos[e * 3 + 2], pos[f * 3 + 2]) > maxz) return false;
  if (Math.max(pos[d * 3 + 2], pos[e * 3 + 2], pos[f * 3 + 2]) < minz) return false;
  return true;
}

/**
 * Executa a etapa de healing sobre o estado de trabalho atual.
 * Retorna estatísticas + log + `undo()` (desfaz todos os patches aplicados,
 * em ordem reversa). O engine valida UMA vez após o healing e desfaz se
 * reprovar — evita N validações globais em malhas de milhões de faces.
 */
export function healSurface(
  mesh: HealingMesh,
  ref: HealingReference,
  opts: HealingOptions,
): { stats: HealingStats; undo: () => void } {
  const applied: Array<{ v: number; faces: number[] }> = [];
  const undo = (): void => {
    for (let i = applied.length - 1; i >= 0; i -= 1) {
      undoPatch(mesh, applied[i].v, applied[i].faces);
    }
  };
  const started = performance.now();
  const stats: HealingStats = {
    defectsFound: 0, defectsRepaired: 0, defectsRolledBack: 0,
    facesAdded: 0, timeMs: 0, log: [],
  };
  const newEdges = findNewBoundaryEdges(mesh, ref);
  if (newEdges.length === 0) {
    stats.timeMs = performance.now() - started;
    return { stats, undo };
  }
  const traced = traceLoops(newEdges, Math.max(opts.maxLoopEdges, 4));
  const loops = traced.loops.slice(0, opts.maxDefects);
  stats.defectsFound = loops.length;
  if (traced.leftoverEdges > 0) {
    // Dano complexo não-decomposto em loops simples: registrado como
    // recusado (o engine decide rollback global da estratégia).
    stats.defectsFound += 1;
    stats.defectsRolledBack += 1;
    stats.log.push({
      kind: 'complex-tear',
      center: [0, 0, 0],
      size: 0,
      facesAdded: 0,
      errorBefore: 0,
      errorAfter: 0,
      timeMs: 0,
      rolledBack: true,
      reason: `${traced.leftoverEdges} aresta(s) de borda nova fora de loops simples — grande demais para patch econômico`,
    });
  }

  for (const loop of loops) {
    const t0 = performance.now();
    const { center, area, perimeter } = loopStats(mesh, loop);
    const size = Math.sqrt(area) / ref.diagonal;
    const entry: HealingLogEntry = {
      kind: loop.length <= opts.maxLoopEdges ? 'hole' : 'tear',
      center, size, facesAdded: 0,
      errorBefore: 0, errorAfter: 0,
      timeMs: 0, rolledBack: false,
    };
    // Lágrimas grandes: recusa honesta (rollback da estratégia, não patch).
    if (loop.length > opts.maxLoopEdges || stats.facesAdded + loop.length > opts.faceBudget) {
      entry.rolledBack = true;
      entry.reason = loop.length > opts.maxLoopEdges
        ? `loop com ${loop.length} arestas excede o máximo tratável (${opts.maxLoopEdges})`
        : 'orçamento de faces de reparo esgotado';
      entry.timeMs = performance.now() - t0;
      stats.defectsRolledBack += 1;
      stats.log.push(entry);
      continue;
    }
    // Erro antes: distância do centroide à referência.
    const before = closestOnReference(ref.grid, center[0], center[1], center[2]);
    entry.errorBefore = Math.sqrt(before.dist2) / ref.diagonal;

    // Centroide PROJETADO na referência (tampa curva, nunca plana).
    const v = mesh.allocVertex();
    if (v < 0) {
      entry.rolledBack = true;
      entry.reason = 'sem slots de vértice livres';
      entry.timeMs = performance.now() - t0;
      stats.defectsRolledBack += 1;
      stats.log.push(entry);
      continue;
    }
    mesh.pos[v * 3] = before.qx;
    mesh.pos[v * 3 + 1] = before.qy;
    mesh.pos[v * 3 + 2] = before.qz;
    mesh.vertAlive[v] = 1;
    mesh.resetQuadric(v);
    mesh.inheritRegion(v, loop);
    mesh.bumpVertex(v);

    // Orientação: alinha o fan com a normal da referência (sem inversões).
    const loopN = newellNormal(mesh, loop);
    const flip = loopN[0] * before.nx + loopN[1] * before.ny + loopN[2] * before.nz < 0;

    const addedFaces: number[] = [];
    let failed: string | null = null;
    for (let i = 0; i < loop.length && !failed; i += 1) {
      const f = mesh.allocFace();
      if (f < 0) {
        failed = 'sem slots de face livres';
        break;
      }
      const i0 = v;
      const i1 = flip ? loop[(i + 1) % loop.length] : loop[i];
      const i2 = flip ? loop[i] : loop[(i + 1) % loop.length];
      mesh.tri[f * 3] = i0; mesh.tri[f * 3 + 1] = i1; mesh.tri[f * 3 + 2] = i2;
      mesh.triAlive[f] = 1;
      mesh.vertFaces[i0].push(f); mesh.vertFaces[i1].push(f); mesh.vertFaces[i2].push(f);
      mesh.addEdge(i0, i1, f); mesh.addEdge(i1, i2, f); mesh.addEdge(i2, i0, f);
      {
        const n = faceNormalOfPositions(mesh.pos, i0, i1, i2);
        mesh.faceNormals[f * 3] = n[0];
        mesh.faceNormals[f * 3 + 1] = n[1];
        mesh.faceNormals[f * 3 + 2] = n[2];
      }
      addedFaces.push(f);
      // Gate local: aspecto + normal vs. referência (sem slivers/inversões).
      const n = faceNormalOfPositions(mesh.pos, i0, i1, i2);
      const nl = Math.hypot(n[0], n[1], n[2]);
      if (!(nl > 1e-18)) {
        failed = 'face degenerada no patch';
        break;
      }
      const asp = triangleAspect(
        mesh.pos[i0 * 3], mesh.pos[i0 * 3 + 1], mesh.pos[i0 * 3 + 2],
        mesh.pos[i1 * 3], mesh.pos[i1 * 3 + 1], mesh.pos[i1 * 3 + 2],
        mesh.pos[i2 * 3], mesh.pos[i2 * 3 + 1], mesh.pos[i2 * 3 + 2],
      );
      if (!(asp <= 12)) {
        failed = `aspecto excessivo no patch (${asp.toFixed(1)})`;
        break;
      }
      const dot = (n[0] * before.nx + n[1] * before.ny + n[2] * before.nz) / nl;
      if (!(dot > 0.15)) {
        failed = 'normal do patch diverge da referência';
        break;
      }
    }

    // Auto-interseção: patch × vizinhança (só pares com AABB sobreposta).
    if (!failed) {
      const neighborFaces = new Set<number>();
      for (const lv of loop) {
        for (const f of mesh.vertFaces[lv]) {
          if (mesh.triAlive[f] && !addedFaces.includes(f)) neighborFaces.add(f);
        }
      }
      outer: for (const nf of addedFaces) {
        const na = mesh.tri[nf * 3]; const nb = mesh.tri[nf * 3 + 1]; const nc = mesh.tri[nf * 3 + 2];
        for (const of_ of neighborFaces) {
          const oa = mesh.tri[of_ * 3]; const ob = mesh.tri[of_ * 3 + 1]; const oc = mesh.tri[of_ * 3 + 2];
          // Compartilham vértice do loop: adjacência esperada, não interseção.
          if (na === oa || na === ob || na === oc || nb === oa || nb === ob || nb === oc || nc === oa || nc === ob || nc === oc) continue;
          if (!aabbOverlap(mesh.pos, na, nb, nc, oa, ob, oc)) continue;
          const p = mesh.pos;
          if (trianglesIntersect(
            p[na * 3], p[na * 3 + 1], p[na * 3 + 2], p[nb * 3], p[nb * 3 + 1], p[nb * 3 + 2], p[nc * 3], p[nc * 3 + 1], p[nc * 3 + 2],
            p[oa * 3], p[oa * 3 + 1], p[oa * 3 + 2], p[ob * 3], p[ob * 3 + 1], p[ob * 3 + 2], p[oc * 3], p[oc * 3 + 1], p[oc * 3 + 2],
          )) {
            failed = 'auto-interseção patch×vizinhança';
            break outer;
          }
        }
      }
    }

    if (failed) {
      undoPatch(mesh, v, addedFaces);
      entry.rolledBack = true;
      entry.reason = failed;
      entry.timeMs = performance.now() - t0;
      stats.defectsRolledBack += 1;
      stats.log.push(entry);
      continue;
    }

    // Erro depois: pior distância dos centroides das faces novas.
    let worst = 0;
    for (const nf of addedFaces) {
      const na = mesh.tri[nf * 3]; const nb = mesh.tri[nf * 3 + 1]; const nc = mesh.tri[nf * 3 + 2];
      const qx = (mesh.pos[na * 3] + mesh.pos[nb * 3] + mesh.pos[nc * 3]) / 3;
      const qy = (mesh.pos[na * 3 + 1] + mesh.pos[nb * 3 + 1] + mesh.pos[nc * 3 + 1]) / 3;
      const qz = (mesh.pos[na * 3 + 2] + mesh.pos[nb * 3 + 2] + mesh.pos[nc * 3 + 2]) / 3;
      const q = closestOnReference(ref.grid, qx, qy, qz);
      const d = Math.sqrt(q.dist2) / ref.diagonal;
      if (d > worst) worst = d;
    }
    entry.errorAfter = worst;
    entry.facesAdded = addedFaces.length;
    entry.timeMs = performance.now() - t0;
    // Aceitação provisória: gates locais passaram. A validação GLOBAL do
    // estágio (uma vez, pelo engine) decide em definitivo; se reprovar, o
    // engine chama undo() e tudo volta ao estado anterior.
    applied.push({ v, faces: addedFaces });
    stats.defectsRepaired += 1;
    stats.facesAdded += addedFaces.length;
    stats.log.push(entry);
  }

  stats.timeMs = performance.now() - started;
  return { stats, undo };
}

/** Desfaz um patch exatamente (ordem reversa das operações). */
function undoPatch(mesh: HealingMesh, v: number, faces: number[]): void {
  for (let i = faces.length - 1; i >= 0; i -= 1) {
    const f = faces[i];
    const i0 = mesh.tri[f * 3]; const i1 = mesh.tri[f * 3 + 1]; const i2 = mesh.tri[f * 3 + 2];
    mesh.removeEdge(i0, i1, f); mesh.removeEdge(i1, i2, f); mesh.removeEdge(i2, i0, f);
    removeFromList(mesh.vertFaces[i0], f);
    removeFromList(mesh.vertFaces[i1], f);
    removeFromList(mesh.vertFaces[i2], f);
    mesh.releaseFace(f);
  }
  mesh.releaseVertex(v);
}

function removeFromList(list: number[], value: number): void {
  const index = list.indexOf(value);
  if (index < 0) return;
  list[index] = list[list.length - 1];
  list.pop();
}


