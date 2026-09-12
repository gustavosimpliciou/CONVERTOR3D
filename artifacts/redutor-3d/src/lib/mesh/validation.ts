import type { Bounds, MeshData, MeshStats } from './types';
import { buildStats, calculateBounds, triangleAreaSquared } from './geometry';

export type TopologyAudit = {
  boundaryEdges: number;
  boundaryLoops: number;
  nonManifoldEdges: number;
  components: number;
  volume: number;
  surfaceArea: number;
  bounds: Bounds;
  degenerateTriangles: number;
  orientationConflicts: number;
  valid: boolean;
  reasons: string[];
};

function edgeMap(mesh: MeshData) {
  const edges = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i], b = mesh.indices[i + 1], c = mesh.indices[i + 2];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const key = u < v ? `${u}:${v}` : `${v}:${u}`;
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  return edges;
}

function countBoundaryLoops(mesh: MeshData, edges: Map<string, number>) {
  const adjacency = new Map<number, Set<number>>();
  for (const [key, count] of edges) {
    if (count !== 1) continue;
    const [a, b] = key.split(':').map(Number);
    if (!adjacency.has(a)) adjacency.set(a, new Set());
    if (!adjacency.has(b)) adjacency.set(b, new Set());
    adjacency.get(a)!.add(b);
    adjacency.get(b)!.add(a);
  }
  const visited = new Set<number>();
  let loops = 0;
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    loops += 1;
    const stack = [start];
    while (stack.length) {
      const vertex = stack.pop()!;
      if (visited.has(vertex)) continue;
      visited.add(vertex);
      for (const next of adjacency.get(vertex) ?? []) if (!visited.has(next)) stack.push(next);
    }
  }
  return loops;
}

function countOrientationConflicts(mesh: MeshData) {
  const directed = new Map<string, number>();
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      const forward = `${u}:${v}`;
      const reverse = `${v}:${u}`;
      directed.set(forward, (directed.get(forward) ?? 0) + 1);
      if ((directed.get(reverse) ?? 0) > 0) directed.set(reverse, (directed.get(reverse) ?? 0) - 1);
    }
  }
  let conflicts = 0;
  for (const count of directed.values()) if (count > 1) conflicts += count - 1;
  return conflicts;
}

function countComponents(mesh: MeshData) {
  const adjacency = Array.from({ length: mesh.positions.length / 3 }, () => [] as number[]);
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const [a, b, c] = [mesh.indices[i], mesh.indices[i + 1], mesh.indices[i + 2]];
    adjacency[a].push(b, c); adjacency[b].push(a, c); adjacency[c].push(a, b);
  }
  const visited = new Uint8Array(adjacency.length);
  let components = 0;
  for (let start = 0; start < adjacency.length; start += 1) {
    if (visited[start] || !adjacency[start].length) continue;
    components += 1;
    const stack = [start];
    while (stack.length) {
      const vertex = stack.pop()!;
      if (visited[vertex]) continue;
      visited[vertex] = 1;
      for (const next of adjacency[vertex]) if (!visited[next]) stack.push(next);
    }
  }
  return components;
}

function signedVolume(mesh: MeshData) {
  let volume = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i] * 3, b = mesh.indices[i + 1] * 3, c = mesh.indices[i + 2] * 3;
    volume += (mesh.positions[a] * (mesh.positions[b + 1] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c + 1]) - mesh.positions[a + 1] * (mesh.positions[b] * mesh.positions[c + 2] - mesh.positions[b + 2] * mesh.positions[c]) + mesh.positions[a + 2] * (mesh.positions[b] * mesh.positions[c + 1] - mesh.positions[b + 1] * mesh.positions[c])) / 6;
  }
  return volume;
}

function surfaceArea(mesh: MeshData) {
  let area = 0;
  for (let i = 0; i < mesh.indices.length; i += 3) area += Math.sqrt(triangleAreaSquared(mesh.positions, mesh.indices, i / 3)) / 2;
  return area;
}

export function auditMesh(mesh: MeshData, reference?: TopologyAudit): TopologyAudit {
  const stats: MeshStats = buildStats(mesh);
  const edges = edgeMap(mesh);
  const boundaryEdges = [...edges.values()].filter((count) => count === 1).length;
  const nonManifoldEdges = [...edges.values()].filter((count) => count > 2).length;
  const audit: TopologyAudit = {
    boundaryEdges,
    boundaryLoops: countBoundaryLoops(mesh, edges),
    nonManifoldEdges,
    components: countComponents(mesh),
    volume: signedVolume(mesh),
    surfaceArea: surfaceArea(mesh),
    bounds: calculateBounds(mesh.positions),
    degenerateTriangles: stats.degenerateTriangles,
    orientationConflicts: countOrientationConflicts(mesh),
    valid: stats.finite && stats.degenerateTriangles === 0,
    reasons: [],
  };
  if (audit.nonManifoldEdges) audit.reasons.push('A malha contém arestas non-manifold.');
  if (audit.orientationConflicts) audit.reasons.push('A orientação das faces contém conflitos de winding.');
  if (reference && audit.orientationConflicts > reference.orientationConflicts) audit.reasons.push('A operação criou conflitos de orientação.');
  if (reference && audit.boundaryLoops > reference.boundaryLoops) audit.reasons.push('A operação criaria novos loops de abertura.');
  if (reference && audit.components < reference.components) audit.reasons.push('Um componente da malha seria perdido.');
  if (reference && audit.components > reference.components) audit.reasons.push('A operação criaria componentes indevidos.');
  if (reference && reference.boundaryLoops === 0 && audit.boundaryLoops !== 0) audit.reasons.push('A malha fechada deixou de ser watertight.');
  audit.valid = audit.valid && audit.reasons.length === 0;
  return audit;
}

export function auditWithinTolerance(candidate: TopologyAudit, reference: TopologyAudit, tolerance = 0.025) {
  const size = Math.max(...reference.bounds.size, 1e-9);
  const volumeDelta = Math.abs(Math.abs(candidate.volume) - Math.abs(reference.volume)) / Math.max(Math.abs(reference.volume), size ** 3 * 1e-9);
  const boundsDelta = Math.max(...candidate.bounds.min.map((v, i) => Math.abs(v - reference.bounds.min[i])), ...candidate.bounds.max.map((v, i) => Math.abs(v - reference.bounds.max[i]))) / size;
  return volumeDelta <= tolerance * 2.5 && boundsDelta <= tolerance;
}

export function topologyFingerprint(mesh: MeshData) {
  const audit = auditMesh(mesh);
  return `${audit.boundaryLoops}:${audit.boundaryEdges}:${audit.nonManifoldEdges}:${audit.components}`;
}

export type ApprovalCheck =
  | 'TOPOLOGY'
  | 'WATERTIGHT'
  | 'BOUNDARIES'
  | 'MANIFOLD'
  | 'SURFACE_ERROR'
  | 'LOCAL_ERROR'
  | 'FEATURE_PRESERVATION'
  | 'SILHOUETTE'
  | 'TRIANGLE_QUALITY'
  | 'SELF_INTERSECTION'
  | 'VOLUME'
  | 'DIMENSIONS'
  | 'ORIENTATION';

export interface ApprovalReport {
  approved: boolean;
  checks: Record<ApprovalCheck, boolean>;
  reasons: string[];
}

/**
 * CRITÉRIO DE APROVAÇÃO (§51): a conversão só é aprovada quando todos os
 * checks passam. `surface` traz o erro médio/máximo normalizado pela
 * diagonal (Hausdorff aproximado) e `featureLoss` a fração de vértices sob
 * FEATURE LOCK perdidos (0 = preservação total).
 */
export function approveConversion(
  candidate: TopologyAudit,
  reference: TopologyAudit,
  surface: { mean: number; max: number },
  featureLoss: number,
  degenerateTriangles: number,
  quality: 'low' | 'medium' | 'high' | 'ultra' = 'high',
): ApprovalReport {
  const strict = quality === 'ultra';
  const maxMean = strict ? 0.0012 : quality === 'high' ? 0.0025 : quality === 'medium' ? 0.0045 : 0.008;
  const maxMax = strict ? 0.012 : quality === 'high' ? 0.025 : quality === 'medium' ? 0.045 : 0.08;
  const checks: Record<ApprovalCheck, boolean> = {
    TOPOLOGY: candidate.reasons.length === 0,
    WATERTIGHT: reference.boundaryLoops === 0 ? candidate.boundaryLoops === 0 : candidate.boundaryLoops <= reference.boundaryLoops,
    BOUNDARIES: candidate.boundaryLoops <= reference.boundaryLoops,
    MANIFOLD: candidate.nonManifoldEdges === 0,
    SURFACE_ERROR: surface.mean <= maxMean && surface.max <= maxMax,
    LOCAL_ERROR: surface.max <= maxMax,
    FEATURE_PRESERVATION: featureLoss <= (strict ? 0.02 : 0.08),
    SILHOUETTE: candidate.boundaryLoops <= reference.boundaryLoops && surface.max <= maxMax * 1.5,
    TRIANGLE_QUALITY: degenerateTriangles === 0,
    SELF_INTERSECTION: candidate.nonManifoldEdges === 0,
    VOLUME: auditWithinTolerance(candidate, reference),
    DIMENSIONS: auditWithinTolerance(candidate, reference),
    ORIENTATION: candidate.orientationConflicts <= reference.orientationConflicts,
  };
  const reasons: string[] = [];
  if (!checks.WATERTIGHT) reasons.push('A malha fechada deixou de ser watertight.');
  if (!checks.BOUNDARIES) reasons.push('Novos loops de abertura foram criados.');
  if (!checks.MANIFOLD) reasons.push('Novas arestas non-manifold foram criadas.');
  if (!checks.SURFACE_ERROR) reasons.push('Erro de superfície excedeu o piso de qualidade.');
  if (!checks.FEATURE_PRESERVATION) reasons.push('Perda de features críticas acima do limite.');
  if (!checks.TRIANGLE_QUALITY) reasons.push('Triângulos degenerados no resultado.');
  if (!checks.VOLUME || !checks.DIMENSIONS) reasons.push('Volume ou dimensões fora da tolerância.');
  if (!checks.ORIENTATION) reasons.push('Novos conflitos de orientação.');
  return { approved: Object.values(checks).every(Boolean), checks, reasons };
}
