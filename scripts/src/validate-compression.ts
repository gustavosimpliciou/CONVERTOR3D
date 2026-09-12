/**
 * TESTES DO COMPRESSOR LOSSLESS (MODO 1).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:compression`
 *
 * Para cada teste: original → compressão → descompressão → validação.
 * Registra tamanho, razão, faces, hash, tempo e status. Qualquer divergência
 * byte-a-byte = FAIL (a integridade tem prioridade sobre a razão).
 */
import { analyzeRedundancy } from '../../artifacts/redutor-3d/src/lib/compress/analyzer';
import { assertIdentical, pack3d, packGzip, parsePackHeader, unpack3d, unpackGzip } from '../../artifacts/redutor-3d/src/lib/compress/container';
import { applyTransform, compressSmart, decompressPayload, hasCompressionStreams, invertTransform, shuffleDecode, shuffleEncode } from '../../artifacts/redutor-3d/src/lib/compress/engine';
import { detectFormat } from '../../artifacts/redutor-3d/src/lib/compress/formats';
import { bytesEqual, Sha256, sha256Hex } from '../../artifacts/redutor-3d/src/lib/compress/sha256';
import { asciiStlToBinary, fingerprintStlBinary, verifyByteLossless, verifyGeometryLossless } from '../../artifacts/redutor-3d/src/lib/compress/validation';

let failures = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** STL binário sintético: grade de triângulos quase-planares (redundância realista). */
function makeBinaryStl(faces: number, seed: number): Uint8Array {
  const rand = lcg(seed);
  const out = new Uint8Array(84 + faces * 50);
  const view = new DataView(out.buffer);
  new TextEncoder().encodeInto('synthetic', out.subarray(0, 9));
  view.setUint32(80, faces, true);
  const grid = Math.ceil(Math.sqrt(faces));
  for (let t = 0; t < faces; t += 1) {
    const base = 84 + t * 50;
    const gx = (t % grid) * 0.5;
    const gy = Math.floor(t / grid) * 0.5;
    const jitter = (): number => (rand() - 0.5) * 0.02;
    view.setFloat32(base, 0, true); view.setFloat32(base + 4, 0, true); view.setFloat32(base + 8, 1, true);
    const coords = [gx + jitter(), gy + jitter(), 0.1 * Math.sin(gx) + jitter(),
      gx + 0.5 + jitter(), gy + jitter(), 0.1 * Math.sin(gx + 0.5) + jitter(),
      gx + jitter(), gy + 0.5 + jitter(), 0.1 * Math.cos(gy) + jitter()];
    for (let i = 0; i < 9; i += 1) view.setFloat32(base + 12 + i * 4, coords[i], true);
    view.setUint16(base + 48, 0, true);
  }
  return out;
}

function makeAsciiStl(faces: number): Uint8Array {
  const lines = ['solid synthetic'];
  for (let t = 0; t < faces; t += 1) {
    lines.push('  facet normal 0 0 1');
    lines.push('    outer loop');
    lines.push(`      vertex ${t} 0 0.5`);
    lines.push(`      vertex ${t + 1} 0 0.25`);
    lines.push(`      vertex ${t} 1 0.75`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid synthetic');
  return new TextEncoder().encode(lines.join('\n'));
}

// --- 1. SHA-256 conhecido + incremental ---
{
  const abc = new TextEncoder().encode('abc');
  check('sha256: vetor conhecido', sha256Hex(abc) === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  const h = new Sha256();
  h.update(abc.subarray(0, 1));
  h.update(abc.subarray(1));
  check('sha256: incremental == one-shot', h.digestHex() === sha256Hex(abc));
}

// --- 2. Detecção de formato ---
{
  const bin = makeBinaryStl(10, 7);
  check('formato: STL binário por magic', detectFormat('x.stl', bin).format === 'STL_BINARY');
  const asc = makeAsciiStl(10);
  check('formato: STL ASCII por estrutura', detectFormat('x.stl', asc).format === 'STL_ASCII');
  const obj = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  check('formato: OBJ por estrutura', detectFormat('x.obj', obj).format === 'OBJ');
  const ply = new TextEncoder().encode('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nproperty float y\nproperty float z\nelement face 1\nproperty list uchar int vertex_indices\nend_header\n0 0 0\n1 0 0\n0 1 0\n3 0 1 2\n');
  check('formato: PLY ASCII', detectFormat('x.ply', ply).format === 'PLY_ASCII');
  const zip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, ...new TextEncoder().encode('[Content_Types].xml')]);
  check('formato: 3MF (zip)', detectFormat('x.3mf', zip).format === '3MF');
  const glb = new Uint8Array(20);
  new DataView(glb.buffer).setUint32(0, 0x46546c67, true);
  check('formato: GLB por magic', detectFormat('x.glb', glb).format === 'GLB');
  const rnd = new Uint8Array(256).map((_, i) => (i * 37 + 11) % 251);
  check('formato: desconhecido honesto', detectFormat('x.bin', rnd).format === 'UNKNOWN');
}

// --- 3. Shuffle reversível ---
{
  const data = new Uint8Array(100).map((_, i) => i % 13);
  const { data: enc } = shuffleEncode(data, 0, 7, data.length);
  check('shuffle: roundtrip exato', bytesEqual(shuffleDecode(enc, 7, Math.floor(100 / 7)), data));
}

// --- 4. STL binário pequeno: smart + container + validação ---
{
  const original = makeBinaryStl(200, 42);
  const info = detectFormat('modelo.stl', original);
  const smart = await compressSmart(original, info, 'max');
  const best = Math.min(...smart.tried.map((t) => t.ratio));
  check('smart: vencedora é a menor razão', Math.abs(smart.winner.ratio - best) < 1e-12, `metodo=${smart.winner.method} transform=${smart.winner.transform.id} razao=${(smart.winner.ratio * 100).toFixed(1)}%`);
  const back = await decompressPayload(smart.winner, info);
  check('smart: roundtrip byte-identico', bytesEqual(back, original));
  const packed = pack3d(original, 'modelo.stl', info, smart.winner);
  const { header } = parsePackHeader(packed.bytes);
  check('3dpack: header íntegro', header.format === 'STL_BINARY' && header.faces === 200 && header.originalSize === original.length);
  const { bytes: rebuilt } = await unpack3d(packed.bytes, info);
  const report = verifyByteLossless(original, rebuilt, info);
  check('validacao: LOSSLESS PASS nível A', report.pass && report.tier === 'A', `sha=${report.roundtripSha256.slice(0, 12)}…`);
  const gz = await packGzip(original);
  check('gzip: roundtrip byte-identico', bytesEqual(await unpackGzip(gz), original));
  check('gzip: reduziu', gz.length < original.length, `${original.length} → ${gz.length}`);
}

// --- 5. STL ASCII: nível A + nível B ---
{
  const original = makeAsciiStl(60);
  const info = detectFormat('modelo.stl', original);
  const smart = await compressSmart(original, info, 'balanced');
  const back = await decompressPayload(smart.winner, info);
  check('ascii: nível A byte-identico', bytesEqual(back, original));
  const bin = asciiStlToBinary(original);
  const geo = verifyGeometryLossless(original, 'STL_ASCII', bin, 'STL_BINARY');
  check('ascii→bin: nível B geometria idêntica', geo.pass && geo.tier === 'B', `faces=${geo.facesRoundtrip}`);
  const tampered = new Uint8Array(back);
  tampered[tampered.length - 1] ^= 0xff;
  const bad = verifyByteLossless(original, tampered, info);
  check('validacao: 1 byte diferente = FAIL', !bad.pass, bad.reasons.join(' ').slice(0, 80));
}

// --- 6. Arquivo já comprimido: ganho limitado, bytes intactos ---
{
  const rand = lcg(99);
  const incompressible = new Uint8Array(200000).map(() => Math.floor(rand() * 256));
  const info = detectFormat('dados.bin', incompressible);
  const smart = await compressSmart(incompressible, info, 'max');
  const back = await decompressPayload(smart.winner, info);
  check('incompressível: roundtrip intacto', bytesEqual(back, incompressible));
  check('incompressível: razão honesta (≈1)', smart.winner.ratio > 0.9, `razao=${(smart.winner.ratio * 100).toFixed(1)}%`);
  const rep = analyzeRedundancy(incompressible, info);
  check('analise: entropia alta detectada', rep.entropyBitsPerByte > 7.5, `${rep.entropyBitsPerByte} bits/byte`);
}

// --- 7. Transform apply/invert simétrico ---
{
  const original = makeBinaryStl(50, 5);
  const info = detectFormat('m.stl', original);
  const { data, id } = applyTransform(original, info, 50);
  check('transform: inverte sem perda', bytesEqual(invertTransform(data, id, info), original), id);
}

// --- 8. Container rejeita payload adulterado ---
{
  const original = makeBinaryStl(80, 9);
  const info = detectFormat('m.stl', original);
  const smart = await compressSmart(original, info, 'fast');
  const packed = pack3d(original, 'm.stl', info, smart.winner);
  const tampered = new Uint8Array(packed.bytes);
  tampered[tampered.length - 1] ^= 0x01;
  let rejected = false;
  try {
    await unpack3d(tampered, info);
  } catch {
    rejected = true;
  }
  check('container: payload adulterado = FAIL', rejected);
  check('assertIdentical: confirma igualdade', assertIdentical(original, new Uint8Array(original)).sha256 === sha256Hex(original));
}

// --- 9. Reabertura independente do STL ---
{
  const original = makeBinaryStl(120, 3);
  const fp = fingerprintStlBinary(original);
  check('fingerprint: faces + finitude', fp.faces === 120 && fp.finite, `faces=${fp.faces}`);
  const broken = new Uint8Array(original);
  new DataView(broken.buffer).setUint32(80, 999999, true);
  check('fingerprint: contagem inconsistente rejeitada', fingerprintStlBinary(broken).faces === 0);
}

// --- 10. Modelo grande (300k faces ≈ 15MB): tamanho/razão/tempo/hash ---
{
  console.log('INFO  grande: gerando modelo…');
  const original = makeBinaryStl(300000, 2026);
  const info = detectFormat('grande.stl', original);
  console.log('INFO  grande: comprimindo…');
  const t0 = performance.now();
  const smart = await compressSmart(original, info, 'balanced');
  const compressMs = performance.now() - t0;
  console.log('INFO  grande: empacotando…');
  const packed = pack3d(original, 'grande.stl', info, smart.winner);
  console.log('INFO  grande: descompactando…');
  const t1 = performance.now();
  const { bytes: rebuilt } = await unpack3d(packed.bytes, info);
  const roundtripMs = performance.now() - t1;
  console.log('INFO  grande: validando…');
  const report = verifyByteLossless(original, rebuilt, info);
  const ratio = packed.bytes.length / original.length;
  console.log(`INFO  grande: ${original.length} → ${packed.bytes.length} bytes (${((1 - ratio) * 100).toFixed(2)}% menor) em ${(compressMs / 1000).toFixed(1)}s + roundtrip ${(roundtripMs / 1000).toFixed(1)}s`);
  console.log(`INFO  grande: faces=${report.facesRoundtrip} sha=${report.roundtripSha256.slice(0, 16)}… metodo=${smart.winner.method}+${smart.winner.transform.id}`);
  check('grande: LOSSLESS PASS', report.pass, `faces=${report.facesRoundtrip}`);
  check('grande: reduziu de verdade', ratio < 0.9, `razao=${(ratio * 100).toFixed(1)}%`);
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
