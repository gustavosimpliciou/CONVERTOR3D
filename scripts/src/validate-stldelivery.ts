/**
 * TESTES DA ENTREGA STL/OBJ (saída válida para impressão 3D).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:stl-delivery`
 *
 * Pipeline por teste: ORIGINAL → OTIMIZAÇÃO → STL/OBJ FINAL →
 * REIMPORTAÇÃO → COMPARAÇÃO → APROVAÇÃO. Faces NUNCA mudam; qualquer
 * alteração geométrica inesperada = FAIL.
 */
import { validateObjDelivery, validateStlDelivery } from '../../artifacts/redutor-3d/src/lib/compress/geometry-validator';
import { optimizeDelivery } from '../../artifacts/redutor-3d/src/lib/compress/optimizer';
import { detectFormat } from '../../artifacts/redutor-3d/src/lib/compress/formats';
import { outputFileName } from '../../artifacts/redutor-3d/src/lib/compress/stl-io';

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

function makeBinaryStl(faces: number, seed: number): Uint8Array {
  const rand = lcg(seed);
  const out = new Uint8Array(84 + faces * 50);
  const view = new DataView(out.buffer);
  view.setUint32(80, faces, true);
  const grid = Math.ceil(Math.sqrt(faces));
  for (let t = 0; t < faces; t += 1) {
    const base = 84 + t * 50;
    const gx = (t % grid) * 0.5;
    const gy = Math.floor(t / grid) * 0.5;
    view.setFloat32(base, 0, true); view.setFloat32(base + 4, 0, true); view.setFloat32(base + 8, 1, true);
    for (let i = 0; i < 9; i += 1) {
      view.setFloat32(base + 12 + i * 4, gx + gy + (rand() - 0.5) * 0.02 + (i % 3) * 0.5, true);
    }
    view.setUint16(base + 48, 0, true);
  }
  return out;
}

function makeAsciiStl(faces: number): Uint8Array {
  const lines = ['solid joker'];
  for (let t = 0; t < faces; t += 1) {
    lines.push('  facet normal 0.123456 0.654321 0.987654');
    lines.push('    outer loop');
    lines.push(`      vertex ${t * 0.5} 0.25 10.125`);
    lines.push(`      vertex ${t * 0.5 + 1.5} 0.75 20.5`);
    lines.push(`      vertex ${t * 0.5} 1.5 30.875`);
    lines.push('    endloop');
    lines.push('  endfacet');
  }
  lines.push('endsolid joker');
  return new TextEncoder().encode(lines.join('\n'));
}

function makeObj(): Uint8Array {
  const lines = ['# comentario de teste', 'o Teste', ''];
  for (let i = 0; i < 100; i += 1) lines.push(`v   ${i * 0.5}  ${i * 0.25}   ${i * 0.125}    # ponto ${i}`);
  for (let i = 1; i <= 98; i += 1) lines.push(`f  ${i}  ${i + 1}  ${i + 2}`);
  lines.push('');
  return new TextEncoder().encode(lines.join('\n'));
}

// --- 1. ASCII → binário: redução grande, geometria preservada ---
{
  const original = makeAsciiStl(2000);
  const info = detectFormat('joker.stl', original);
  const result = await optimizeDelivery(original, 'joker.stl', info);
  check('ascii2bin: formato detectado', info.format === 'STL_ASCII');
  check('ascii2bin: reduziu de verdade', result.ratio < 0.5, `razao=${(result.ratio * 100).toFixed(1)}%`);
  check('ascii2bin: faces iguais', result.faces === 2000, `faces=${result.faces}`);
  check('ascii2bin: saída .stl', result.deliveredFileName === 'joker_comprimido.stl', result.deliveredFileName);
  check('ascii2bin: nível B declarado', result.tier === 'B', `tier=${result.tier}`);
  const report = result.report;
  check('ascii2bin: validação PASS', report !== null && report.pass, report ? `erromax=${report.maxError}` : 'sem relatório');
  check('ascii2bin: watertight igual', (report?.boundaryOriginal ?? -1) === (report?.boundaryFinal ?? -2));
  console.log(`INFO  ascii2bin: ${original.length} → ${result.deliveredBytes} bytes (${((1 - result.ratio) * 100).toFixed(1)}% menor) método=${result.method}`);
}

// --- 2. Binário → binário: passthrough byte-lossless honesto ---
{
  const original = makeBinaryStl(5000, 11);
  const info = detectFormat('peca.stl', original);
  const result = await optimizeDelivery(original, 'peca.stl', info);
  check('bin2bin: nível A', result.tier === 'A');
  check('bin2bin: bytes idênticos', result.deliveredBytes === original.length);
  check('bin2bin: faces iguais', result.faces === 5000);
  check('bin2bin: validação PASS', result.report !== null && result.report.pass);
  check('bin2bin: saída .stl', result.deliveredFileName === 'peca_comprimido.stl');
}

// --- 3. OBJ: normalização sem tocar nos números ---
{
  const original = makeObj();
  const info = detectFormat('modelo.obj', original);
  const result = await optimizeDelivery(original, 'modelo.obj', info);
  check('obj: reduziu (espaços/comentários)', result.deliveredBytes < original.length, `${original.length} → ${result.deliveredBytes}`);
  const checkObj = validateObjDelivery(original, result.delivered);
  check('obj: faces e coords exatas', checkObj.pass && checkObj.faces === 98, `faces=${checkObj.faces}`);
  check('obj: saída .obj', result.deliveredFileName === 'modelo_comprimido.obj');
}

// --- 4. Adulteração geométrica é rejeitada ---
{
  const original = makeBinaryStl(300, 5);
  const tampered = new Uint8Array(original);
  new DataView(tampered.buffer).setFloat32(84 + 12, 999.25, true);
  const report = validateStlDelivery(original, false, tampered);
  check('tamper: 1 vértice movido = FAIL', !report.pass, report.reasons[0]?.slice(0, 90) ?? '');
  check('tamper: faces continuam iguais (só geometria mudou)', report.facesOriginal === report.facesFinal);
}

// --- 5. Face removida é rejeitada ---
{
  const original = makeBinaryStl(300, 6);
  const view = new DataView(original.buffer);
  const faces = view.getUint32(80, true);
  const cut = original.subarray(0, 84 + (faces - 1) * 50);
  const fixed = new Uint8Array(cut.length);
  fixed.set(cut);
  new DataView(fixed.buffer).setUint32(80, faces - 1, true);
  const report = validateStlDelivery(original, false, fixed);
  check('cut: face removida = FAIL', !report.pass, report.reasons[0]?.slice(0, 90) ?? '');
}

// --- 6. Nome de saída preserva extensão ---
{
  check('nome: stl', outputFileName('JOKER.STL') === 'JOKER_comprimido.STL');
  check('nome: obj', outputFileName('modelo.obj') === 'modelo_comprimido.obj');
  check('nome: sem extensão', outputFileName('modelo') === 'modelo_comprimido');
}

// --- 7. Modelo grande (~1M faces ≈ 50MB): end-to-end com tempo ---
{
  console.log('INFO  grande: gerando 1M faces…');
  const original = makeBinaryStl(1000000, 2026);
  const info = detectFormat('testejoker.stl', original);
  const t0 = performance.now();
  const result = await optimizeDelivery(original, 'testejoker.stl', info);
  const dt = performance.now() - t0;
  console.log(`INFO  grande: ${original.length} → ${result.deliveredBytes} bytes em ${(dt / 1000).toFixed(1)}s, faces=${result.faces}, metodo=${result.method}`);
  check('grande: faces preservadas (1M)', result.faces === 1000000);
  check('grande: validação PASS', result.report !== null && result.report.pass);
  check('grande: saída .stl', result.deliveredFileName === 'testejoker_comprimido.stl');
}

// --- 8. Meta de 50%: status honesto (SUCESSO / PARCIAL) ---
{
  const original = makeAsciiStl(500);
  const info = detectFormat('m.stl', original);
  const result = await optimizeDelivery(original, 'm.stl', info);
  const achieved = (1 - result.ratio) * 100;
  const target = 50;
  const status = achieved >= target ? 'SUCESSO' : 'SUCESSO PARCIAL';
  check('meta: cálculo honesto', status === 'SUCESSO' && achieved > 50, `${achieved.toFixed(1)}% vs meta ${target}% → ${status}`);
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
