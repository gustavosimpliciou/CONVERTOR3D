/**
 * TESTES DA RECONSTRUÇÃO DE SUPERFÍCIE (healing).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:healing`
 *
 * Cobre: detecção de buracos novos, patch curvo guiado pelo original,
 * buraco original ignorado, rasgo grande recusado, rollback sem mutação,
 * orçamento de faces, RMS e interseção triângulo-triângulo.
 */
import { buildTriangleGrid, directedSamplesError, trianglesIntersect } from '../../artifacts/redutor-3d/src/lib/mesh/safeguards';
import { healSurface, type HealingMesh } from '../../artifacts/redutor-3d/src/lib/mesh/surface-healing';
import { auditMesh } from '../../artifacts/redutor-3d/src/lib/mesh/validation';
import { calculateBounds, normalizeTriangles } from '../../artifacts/redutor-3d/src/lib/mesh/geometry';
import type { MeshData } from '../../artifacts/redutor-3d/src/lib/mesh/types';

let failures = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function edgeKeyOf(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

function icosphere(subdivisions: number): MeshData {
  const t = (1 + Math.sqrt(5)) / 2;
  let positions: number[] = [-1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, 0, 0, -1, t, 0, 1, t, 0, -1, -t, 0, 1, -t, t, 0, -1, t, 0, 1, -t, 0, -1, -t, 0, 1];
  let triangles: number[][] = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  const midpoint = (a: number, b: number): number => {
    const mx = (positions[a * 3] + positions[b * 3]) / 2;
    const my = (positions[a * 3 + 1] + positions[b * 3 + 1]) / 2;
    const mz = (positions[a * 3 + 2] + positions[b * 3 + 2]) / 2;
    const len = Math.hypot(mx, my, mz) || 1;
    positions.push((mx / len) * 2, (my / len) * 2, (mz / len) * 2);
    return positions.length / 3 - 1;
  };
  for (let s = 0; s < subdivisions; s += 1) {
    const next: number[][] = [];
    const cache = new Map<string, number>();
    const mid = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let m = cache.get(key);
      if (m === undefined) { m = midpoint(a, b); cache.set(key, m); }
      return m;
    };
    for (const [a, b, c] of triangles) {
      const ab = mid(a, b); const bc = mid(b, c); const ca = mid(c, a);
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }
    triangles = next;
  }
  return normalizeTriangles(positions, triangles, 'STL');
}

function toWorking(mesh: MeshData, spareVerts = 8, spareFaces = 64): {
  pos: Float64Array; tri: Int32Array; triAlive: Uint8Array; vertAlive: Uint8Array;
  vertFaces: Array<number[]>; faceNormals: Float64Array; edgeCounts: Map<string, number>;
  freeVerts: number[]; freeFaces: number[]; faceCount: number; vertexCount: number;
} {
  const vertexCount = mesh.positions.length / 3;
  const faceCount = mesh.indices.length / 3;
  const pos = new Float64Array((vertexCount + spareVerts) * 3);
  for (let i = 0; i < mesh.positions.length; i += 1) pos[i] = mesh.positions[i];
  const tri = new Int32Array((faceCount + spareFaces) * 3);
  for (let i = 0; i < mesh.indices.length; i += 1) tri[i] = mesh.indices[i];
  const triAlive = new Uint8Array(faceCount + spareFaces);
  for (let t = 0; t < faceCount; t += 1) triAlive[t] = 1;
  const vertAlive = new Uint8Array(vertexCount + spareVerts);
  for (let v = 0; v < vertexCount; v += 1) vertAlive[v] = 1;
  const vertFaces: Array<number[]> = Array.from({ length: vertexCount + spareVerts }, () => []);
  const faceNormals = new Float64Array((faceCount + spareFaces) * 3);
  const edgeCounts = new Map<string, number>();
  for (let t = 0; t < faceCount; t += 1) {
    const a = tri[t * 3]; const b = tri[t * 3 + 1]; const c = tri[t * 3 + 2];
    vertFaces[a].push(t); vertFaces[b].push(t); vertFaces[c].push(t);
    const abx = pos[b * 3] - pos[a * 3]; const aby = pos[b * 3 + 1] - pos[a * 3 + 1]; const abz = pos[b * 3 + 2] - pos[a * 3 + 2];
    const acx = pos[c * 3] - pos[a * 3]; const acy = pos[c * 3 + 1] - pos[a * 3 + 1]; const acz = pos[c * 3 + 2] - pos[a * 3 + 2];
    faceNormals[t * 3] = aby * acz - abz * acy;
    faceNormals[t * 3 + 1] = abz * acx - abx * acz;
    faceNormals[t * 3 + 2] = abx * acy - aby * acx;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKeyOf(u, v);
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }
  const freeVerts: number[] = [];
  for (let v = vertexCount; v < vertexCount + spareVerts; v += 1) freeVerts.push(v);
  const freeFaces: number[] = [];
  for (let f = faceCount; f < faceCount + spareFaces; f += 1) freeFaces.push(f);
  return { pos, tri, triAlive, vertAlive, vertFaces, faceNormals, edgeCounts, freeVerts, freeFaces, faceCount, vertexCount };
}

function makeAdapter(w: ReturnType<typeof toWorking>, freeVerts: number[], freeFaces: number[]): HealingMesh {
  return {
    pos: w.pos, tri: w.tri, triAlive: w.triAlive, vertAlive: w.vertAlive,
    vertexCount: w.vertAlive.length, vertFaces: w.vertFaces, faceNormals: w.faceNormals,
    liveEdges: w.edgeCounts,
    allocVertex: () => {
      while (freeVerts.length > 0) {
        const v = freeVerts.pop() as number;
        if (!w.vertAlive[v]) {
          w.vertAlive[v] = 1;
          w.vertFaces[v].length = 0;
          return v;
        }
      }
      return -1;
    },
    allocFace: () => {
      while (freeFaces.length > 0) {
        const f = freeFaces.pop() as number;
        if (!w.triAlive[f]) {
          w.triAlive[f] = 1;
          return f;
        }
      }
      return -1;
    },
    releaseVertex: (v: number) => { w.vertAlive[v] = 0; w.vertFaces[v].length = 0; freeVerts.push(v); },
    releaseFace: (f: number) => { w.triAlive[f] = 0; freeFaces.push(f); },
    resetQuadric: () => undefined,
    inheritRegion: () => undefined,
    bumpVertex: () => undefined,
    addEdge: (a: number, b: number, f: number) => {
      const key = edgeKeyOf(a, b);
      w.edgeCounts.set(key, (w.edgeCounts.get(key) ?? 0) + 1);
      void f;
    },
    removeEdge: (a: number, b: number, f: number) => {
      const key = edgeKeyOf(a, b);
      const count = w.edgeCounts.get(key) ?? 0;
      if (count <= 1) w.edgeCounts.delete(key);
      else w.edgeCounts.set(key, count - 1);
      void f;
    },
  };
}

function refBoundaryOf(w: ReturnType<typeof toWorking>): Set<string> {
  const set = new Set<string>();
  for (const [key, count] of w.edgeCounts) {
    if (count === 1) set.add(key);
  }
  return set;
}

/**
 * Abre um buraco SEM reindexar (mata faces no lugar, como um colapso faria):
 * preserva os ids de vértice para que o mapa de referência continue válido.
 */
function punchWorking(
  w: ReturnType<typeof toWorking>,
  at: [number, number, number],
  count: number,
): void {
  const faceCount = w.faceCount;
  const scored: Array<{ t: number; d: number }> = [];
  for (let t = 0; t < faceCount; t += 1) {
    const cx = (w.pos[w.tri[t * 3] * 3] + w.pos[w.tri[t * 3 + 1] * 3] + w.pos[w.tri[t * 3 + 2] * 3]) / 3;
    const cy = (w.pos[w.tri[t * 3] * 3 + 1] + w.pos[w.tri[t * 3 + 1] * 3 + 1] + w.pos[w.tri[t * 3 + 2] * 3 + 1]) / 3;
    const cz = (w.pos[w.tri[t * 3] * 3 + 2] + w.pos[w.tri[t * 3 + 1] * 3 + 2] + w.pos[w.tri[t * 3 + 2] * 3 + 2]) / 3;
    scored.push({ t, d: Math.hypot(cx - at[0], cy - at[1], cz - at[2]) });
  }
  scored.sort((a, b) => a.d - b.d);
  for (const { t } of scored.slice(0, count)) {
    const a = w.tri[t * 3]; const b = w.tri[t * 3 + 1]; const c = w.tri[t * 3 + 2];
    w.triAlive[t] = 0;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = edgeKeyOf(u, v);
      const n = w.edgeCounts.get(key) ?? 0;
      if (n <= 1) w.edgeCounts.delete(key);
      else w.edgeCounts.set(key, n - 1);
    }
    for (const v of [a, b, c]) {
      const list = w.vertFaces[v];
      const i = list.indexOf(t);
      if (i >= 0) {
        list[i] = list[list.length - 1];
        list.pop();
      }
    }
  }
}

function workingAudit(w: ReturnType<typeof toWorking>): { loops: number } {
  const adj = new Map<number, Set<number>>();
  for (const [key, count] of w.edgeCounts) {
    if (count !== 1) continue;
    const sep = key.indexOf(':');
    const a = Number(key.slice(0, sep));
    const b = Number(key.slice(sep + 1));
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  }
  const visited = new Set<number>();
  let loops = 0;
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    loops += 1;
    const stack = [start];
    while (stack.length > 0) {
      const v = stack.pop() as number;
      if (visited.has(v)) continue;
      visited.add(v);
      for (const n of adj.get(v) ?? []) if (!visited.has(n)) stack.push(n);
    }
  }
  return { loops };
}

// --- 1. Buraco novo: detecta, reconstrói curvo, fecha ---
{
  const original = icosphere(3);
  const refAudit = auditMesh(original);
  const w = toWorking(original);
  punchWorking(w, [0, 2, 0], 4);
  const holeLoops = workingAudit(w).loops;
  check('heal: buraco artificial detectável', holeLoops > refAudit.boundaryLoops, `loops ${refAudit.boundaryLoops} → ${holeLoops}`);
  const grid = buildTriangleGrid(original.positions, original.indices);
  const diag = Math.hypot(...calculateBounds(original.positions).size);
  const refBoundary = refBoundaryOf(toWorking(original));
  const { stats } = healSurface(
    makeAdapter(w, w.freeVerts, w.freeFaces),
    { grid, diagonal: diag, refBoundary },
    { maxDefects: 8, faceBudget: 60, maxLoopEdges: 10 },
  );
  check('heal: defeito encontrado', stats.defectsFound >= 1, `encontrados=${stats.defectsFound}`);
  for (const entry of stats.log) {
    console.log(`INFO  log: kind=${entry.kind} size=${entry.size.toFixed(4)} rolledBack=${entry.rolledBack} reason=${entry.reason ?? '—'} faces=${entry.facesAdded} err=${entry.errorBefore.toFixed(4)}→${entry.errorAfter.toFixed(4)}`);
  }
  check('heal: defeito reconstruído', stats.defectsRepaired >= 1, `reparados=${stats.defectsRepaired}`);
  check('heal: econômico em faces', stats.facesAdded > 0 && stats.facesAdded <= 60, `faces=${stats.facesAdded}`);
  // Remonta a malha e confere watertight restaurado.
  const outIdx: number[] = [];
  for (let t = 0; t < w.tri.length / 3; t += 1) {
    if (!w.triAlive[t]) continue;
    outIdx.push(w.tri[t * 3], w.tri[t * 3 + 1], w.tri[t * 3 + 2]);
  }
  const compact = { positions: new Float32Array(Array.from(w.pos)), indices: new Uint32Array(outIdx), format: 'STL' as const, bounds: calculateBounds(new Float32Array(Array.from(w.pos))) };
  const healedAudit = auditMesh(compact, refAudit);
  check('heal: watertight restaurado', healedAudit.boundaryLoops <= refAudit.boundaryLoops, `loops=${healedAudit.boundaryLoops}`);
  const entry = stats.log.find((l) => !l.rolledBack);
  check('heal: erro depois menor que antes', entry !== undefined && entry.errorAfter <= entry.errorBefore, entry ? `${entry.errorBefore.toFixed(4)} → ${entry.errorAfter.toFixed(4)}` : 'sem entrada');
}

// --- 2. Buraco ORIGINAL é ignorado (não é artefato) ---
{
  const open: MeshData = normalizeTriangles(
    [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 0, 0, 1, 1, 0, 0, 1, 0],
    [[0, 1, 2], [3, 4, 5]],
    'STL',
  );
  const w = toWorking(open);
  const grid = buildTriangleGrid(open.positions, open.indices);
  const diag = Math.hypot(...calculateBounds(open.positions).size);
  const { stats } = healSurface(
    makeAdapter(w, w.freeVerts, w.freeFaces),
    { grid, diagonal: diag, refBoundary: refBoundaryOf(w) },
    { maxDefects: 8, faceBudget: 60, maxLoopEdges: 10 },
  );
  check('heal: abertura original ignorada', stats.defectsFound === 0 && stats.facesAdded === 0);
}

// --- 3. Rasgo grande: recusa honesta, sem mutação ---
{
  const original = icosphere(3);
  const w = toWorking(original);
  punchWorking(w, [0, 2, 0], 120);
  const before = w.triAlive.slice();
  const grid = buildTriangleGrid(original.positions, original.indices);
  const diag = Math.hypot(...calculateBounds(original.positions).size);
  const { stats } = healSurface(
    makeAdapter(w, w.freeVerts, w.freeFaces),
    { grid, diagonal: diag, refBoundary: refBoundaryOf(toWorking(original)) },
    { maxDefects: 8, faceBudget: 60, maxLoopEdges: 10 },
  );
  const mutated = before.some((v, i) => (v === 1) !== (w.triAlive[i] === 1));
  check('heal: rasgo grande recusado', stats.defectsRolledBack >= 1 && stats.facesAdded === 0);
  check('heal: recusa não muta a malha', !mutated);
}

// --- 4. Orçamento estourado: recusa sem mutação ---
{
  const original = icosphere(3);
  const w = toWorking(original);
  punchWorking(w, [0, 2, 0], 4);
  const before = w.triAlive.slice();
  const grid = buildTriangleGrid(original.positions, original.indices);
  const diag = Math.hypot(...calculateBounds(original.positions).size);
  const { stats } = healSurface(
    makeAdapter(w, w.freeVerts, w.freeFaces),
    { grid, diagonal: diag, refBoundary: refBoundaryOf(toWorking(original)) },
    { maxDefects: 8, faceBudget: 0, maxLoopEdges: 10 },
  );
  const mutated = before.some((v, i) => (v === 1) !== (w.triAlive[i] === 1));
  check('heal: budget zero recusa tudo', stats.defectsRepaired === 0 && stats.facesAdded === 0 && !mutated);
}

// --- 5. RMS: identidade 0, RMS <= máx ---
{
  const mesh = icosphere(2);
  const diag = Math.hypot(...calculateBounds(mesh.positions).size);
  const grid = buildTriangleGrid(mesh.positions, mesh.indices);
  const err = directedSamplesError(grid, mesh.positions, mesh.positions.length / 3, null, diag, 300);
  check('rms: identidade', err.mean === 0 && err.max === 0 && err.rms === 0);
}

// --- 6. Interseção triângulo-triângulo ---
{
  const cross = trianglesIntersect(
    0, 0, 0, 2, 0, 0, 0, 2, 0,
    1, 1, -1, 1, 1, 1, 1, -1, 0,
  );
  const apart = trianglesIntersect(
    0, 0, 0, 1, 0, 0, 0, 1, 0,
    5, 5, 5, 6, 5, 5, 5, 6, 5,
  );
  check('intersect: cruzamento detectado', cross);
  check('intersect: separados não colidem', !apart);
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
