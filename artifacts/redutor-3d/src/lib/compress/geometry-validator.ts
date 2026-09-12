/**
 * GeometryValidator + TopologyValidator
 * --------------------------------------
 * Pipeline de aprovação: ORIGINAL → OTIMIZAÇÃO → STL FINAL → REIMPORTAÇÃO
 * → COMPARAÇÃO → APROVAÇÃO.
 *
 * Compara original vs. final em: faces, bbox, dimensões, posição,
 * volume, área, centroide, normais, conectividade (componentes),
 * bordas/loops, manifold, watertight, degeneração e distância
 * superfície-a-superfície (média, máxima, Hausdorff aproximado).
 *
 * NÍVEL A (binário→binário passthrough): tudo EXATO, incluindo bytes.
 * NÍVEL B (ascii→binário, obj normalizado): coordenadas float32 exatas,
 * topologia igual, Hausdorff dentro do ruído numérico.
 * Qualquer alteração inesperada → REJEITA (nada é entregue).
 */

import { approximateSurfaceError } from '../mesh/safeguards';
import { auditMesh } from '../mesh/validation';
import type { MeshData } from '../mesh/types';
import { countObjFaces, extractObjCoords, parseAsciiStlMesh, readBinaryStlMesh } from './stl-io';
import { bytesEqual, sha256Hex } from './sha256';
import { fingerprintStlBinary } from './validation';

export interface GeometryReport {
  pass: boolean;
  tier: 'A' | 'B';
  checks: Record<string, boolean>;
  reasons: string[];
  facesOriginal: number;
  facesFinal: number;
  originalBytes: number;
  finalBytes: number;
  originalSha256: string;
  finalSha256: string;
  boundsDelta: number;
  volumeDeltaPercent: number;
  areaDeltaPercent: number;
  centroidDelta: number;
  meanError: number;
  maxError: number;
  boundaryOriginal: number;
  boundaryFinal: number;
  nonManifoldOriginal: number;
  nonManifoldFinal: number;
}

export type { GeometryFingerprint } from './validation';

function centroidOf(mesh: MeshData): [number, number, number] {
  const n = mesh.positions.length / 3;
  if (n === 0) return [0, 0, 0];
  let x = 0; let y = 0; let z = 0;
  for (let i = 0; i < mesh.positions.length; i += 3) {
    x += mesh.positions[i]; y += mesh.positions[i + 1]; z += mesh.positions[i + 2];
  }
  return [x / n, y / n, z / n];
}

function floatArraysEqual(a: Float32Array | number[], b: Float32Array | number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function validateStlDelivery(
  original: Uint8Array,
  originalIsAscii: boolean,
  final: Uint8Array,
): GeometryReport {
  const reasons: string[] = [];
  const checks: Record<string, boolean> = {};
  const fail = (key: string, reason: string): void => {
    checks[key] = false;
    reasons.push(reason);
  };

  // FAST-PATH NÍVEL A: binário→binário com bytes idênticos é matematicamente
  // a mesma malha — auditoria completa (welding O(V)) seria puro desperdício
  // em arquivos de 100MB+. Fingerprint O(T) barato + igualdade de bytes.
  if (!originalIsAscii && bytesEqual(original, final)) {
    const fp = fingerprintStlBinary(final);
    const diag = Math.max(
      fp.max[0] - fp.min[0], fp.max[1] - fp.min[1], fp.max[2] - fp.min[2], 1e-12,
    );
    const ok = fp.finite && fp.faces > 0;
    if (!ok) reasons.push('STL final inválido na reabertura independente.');
    for (const key of ['faces', 'coordenadas', 'normais', 'bbox', 'volume', 'area', 'centroide', 'watertight', 'bordas', 'manifold', 'componentes', 'degeneracao', 'superficie', 'bytes']) {
      checks[key] = ok;
    }
    return {
      pass: ok,
      tier: 'A',
      checks,
      reasons,
      facesOriginal: fp.faces,
      facesFinal: fp.faces,
      originalBytes: original.length,
      finalBytes: final.length,
      originalSha256: sha256Hex(original),
      finalSha256: sha256Hex(final),
      boundsDelta: 0,
      volumeDeltaPercent: 0,
      areaDeltaPercent: 0,
      centroidDelta: 0,
      meanError: 0,
      maxError: 0,
      // -1 = topologia preservada por construção (bytes idênticos ⇒ mesma
      // topologia, seja ela qual for); contar loops exigiria welding O(V),
      // desperdício em arquivos de 100MB+ quando nada mudou.
      boundaryOriginal: -1,
      boundaryFinal: -1,
      nonManifoldOriginal: 0,
      nonManifoldFinal: 0,
    };
  }

  const origText = originalIsAscii ? new TextDecoder().decode(original) : null;
  const origParsed = originalIsAscii && origText !== null
    ? parseAsciiStlMesh(origText)
    : readBinaryStlMesh(original);
  const finalParsed = readBinaryStlMesh(final);

  const tier: 'A' | 'B' = originalIsAscii ? 'B' : 'A';
  const refAudit = auditMesh(origParsed.mesh);
  const finAudit = auditMesh(finalParsed.mesh, refAudit);

  // Faces / triângulos.
  checks['faces'] = origParsed.faces === finalParsed.faces;
  if (!checks['faces']) fail('faces', `Faces divergentes (${finalParsed.faces} ≠ ${origParsed.faces}).`);

  // Coordenadas float32 exatas (ordem das faces preservada pela conversão).
  const coordsEqual = floatArraysEqual(origParsed.coords, finalParsed.coords);
  checks['coordenadas'] = coordsEqual;
  if (!coordsEqual) fail('coordenadas', 'Coordenadas divergentes além do float32.');

  // Normais exatas.
  const normalsEqual = floatArraysEqual(origParsed.normals, finalParsed.normals);
  checks['normais'] = normalsEqual;
  if (!normalsEqual) fail('normais', 'Normais divergentes.');

  // Bounding box / dimensões / posição.
  const diag = Math.max(Math.hypot(...refAudit.bounds.size), 1e-12);
  const boundsDelta = Math.max(
    ...finAudit.bounds.min.map((v, i) => Math.abs(v - refAudit.bounds.min[i])),
    ...finAudit.bounds.max.map((v, i) => Math.abs(v - refAudit.bounds.max[i])),
  ) / diag;
  checks['bbox'] = boundsDelta === 0 || (tier === 'B' && boundsDelta < 1e-6);
  if (!checks['bbox']) fail('bbox', `Bounding box divergente (${boundsDelta}).`);

  // Volume / área.
  const volScale = Math.max(Math.abs(refAudit.volume), diag ** 3 * 1e-6);
  const volumeDeltaPercent = (Math.abs(Math.abs(finAudit.volume) - Math.abs(refAudit.volume)) / volScale) * 100;
  checks['volume'] = volumeDeltaPercent === 0 || (tier === 'B' && volumeDeltaPercent < 1e-4);
  if (!checks['volume']) fail('volume', `Volume divergente (${volumeDeltaPercent}%).`);
  const areaScale = Math.max(refAudit.surfaceArea, diag * diag * 1e-9);
  const areaDeltaPercent = (Math.abs(finAudit.surfaceArea - refAudit.surfaceArea) / areaScale) * 100;
  checks['area'] = areaDeltaPercent === 0 || (tier === 'B' && areaDeltaPercent < 1e-4);
  if (!checks['area']) fail('area', `Área divergente (${areaDeltaPercent}%).`);

  // Centroide.
  const [ax, ay, az] = centroidOf(origParsed.mesh);
  const [bx, by, bz] = centroidOf(finalParsed.mesh);
  const centroidDelta = Math.hypot(bx - ax, by - ay, bz - az) / diag;
  checks['centroide'] = centroidDelta === 0 || (tier === 'B' && centroidDelta < 1e-6);
  if (!checks['centroide']) fail('centroide', 'Centroide deslocado.');

  // Topologia: watertight, bordas, manifold, componentes, degeneração.
  checks['watertight'] = (refAudit.boundaryLoops === 0) === (finAudit.boundaryLoops === 0);
  if (!checks['watertight']) fail('watertight', 'Estado watertight alterado.');
  checks['bordas'] = finAudit.boundaryLoops <= refAudit.boundaryLoops;
  if (!checks['bordas']) fail('bordas', `Novos loops de borda (${finAudit.boundaryLoops} > ${refAudit.boundaryLoops}).`);
  checks['manifold'] = finAudit.nonManifoldEdges <= refAudit.nonManifoldEdges;
  if (!checks['manifold']) fail('manifold', 'Novas arestas non-manifold.');
  checks['componentes'] = finAudit.components === refAudit.components;
  if (!checks['componentes']) fail('componentes', 'Componentes alterados.');
  checks['degeneracao'] = finAudit.degenerateTriangles === 0;
  if (!checks['degeneracao']) fail('degeneracao', 'Triângulos degenerados no final.');

  // Distância superfície-a-superfície (erro local + global). Amostras
  // adaptativas: malhas gigantes validam com menos pontos (O(n) por ponto).
  const sampleCount = origParsed.faces > 200000 ? 500 : 1200;
  const err = approximateSurfaceError(
    { positions: origParsed.mesh.positions, indices: origParsed.mesh.indices },
    { positions: finalParsed.mesh.positions, indices: finalParsed.mesh.indices },
    diag,
    sampleCount,
  );
  const errTol = tier === 'A' ? 1e-9 : 1e-4;
  checks['superficie'] = err.mean <= errTol && err.max <= errTol * 10;
  if (!checks['superficie']) fail('superficie', `Erro de superfície (média ${err.mean}, máx ${err.max}).`);

  // Nível A exige bytes idênticos; nível B, hash necessariamente difere.
  if (tier === 'A') {
    checks['bytes'] = original.length === final.length &&
      original.every((v, i) => v === final[i]);
    if (!checks['bytes']) fail('bytes', 'Bytes divergentes no nível A.');
  } else {
    checks['bytes'] = true;
  }

  const pass = Object.values(checks).every(Boolean);
  return {
    pass,
    tier,
    checks,
    reasons,
    facesOriginal: origParsed.faces,
    facesFinal: finalParsed.faces,
    originalBytes: original.length,
    finalBytes: final.length,
    originalSha256: sha256Hex(original),
    finalSha256: sha256Hex(final),
    boundsDelta,
    volumeDeltaPercent,
    areaDeltaPercent,
    centroidDelta,
    meanError: err.mean,
    maxError: err.max,
    boundaryOriginal: refAudit.boundaryLoops,
    boundaryFinal: finAudit.boundaryLoops,
    nonManifoldOriginal: refAudit.nonManifoldEdges,
    nonManifoldFinal: finAudit.nonManifoldEdges,
  };
}

/** Validação OBJ normalizado: mesmas faces, mesmas coordenadas exatas. */
export function validateObjDelivery(original: Uint8Array, final: Uint8Array): { pass: boolean; reasons: string[]; faces: number } {
  const reasons: string[] = [];
  const facesA = countObjFaces(original);
  const facesB = countObjFaces(final);
  if (facesA !== facesB || facesA === 0) reasons.push(`Faces OBJ divergentes (${facesB} ≠ ${facesA}).`);
  const coordsA = extractObjCoords(original);
  const coordsB = extractObjCoords(final);
  if (coordsA.length !== coordsB.length) reasons.push('Contagem de vértices OBJ divergente.');
  else {
    for (let i = 0; i < coordsA.length; i += 1) {
      if (coordsA[i] !== coordsB[i]) {
        reasons.push(`Coordenada OBJ divergente no índice ${i}.`);
        break;
      }
    }
  }
  return { pass: reasons.length === 0, reasons, faces: facesA };
}
