/**
 * TESTES DO FLUXO DE UPLOAD (upload ≠ otimização).
 *
 * Execução: `pnpm --filter @workspace/scripts run validate:upload`
 *
 * Regra suprema: upload aceito se o arquivo for LEGÍVEL. Geometria
 * problemática (aberturas, non-manifold) é aceita com `quirks` — nunca
 * recusada. Erros de leitura são específicos, nunca genéricos, e nunca
 * mencionam redução.
 */
import { isZeroReductionError } from '../../artifacts/redutor-3d/src/lib/mesh/processor';
import { NotStlError, parseStlForImport } from '../../artifacts/redutor-3d/src/lib/mesh/stl-import';

let failures = 0;
const check = (name: string, condition: boolean, detail = ''): void => {
  if (condition) console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
  else {
    failures += 1;
    console.error(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
};

function binaryStl(triangles: Array<[[number, number, number], [number, number, number], [number, number, number]]>): Uint8Array {
  const out = new Uint8Array(84 + triangles.length * 50);
  const view = new DataView(out.buffer);
  new TextEncoder().encodeInto('test', out.subarray(0, 4));
  view.setUint32(80, triangles.length, true);
  triangles.forEach(([a, b, c], t) => {
    const base = 84 + t * 50;
    view.setFloat32(base + 8, 1, true);
    [a, b, c].forEach((p, v) => {
      view.setFloat32(base + 12 + v * 12, p[0], true);
      view.setFloat32(base + 12 + v * 12 + 4, p[1], true);
      view.setFloat32(base + 12 + v * 12 + 8, p[2], true);
    });
  });
  return out;
}

const TETRA: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
  [[0, 0, 0], [0, 1, 0], [1, 0, 0]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
  [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
];

// --- 1. Binário válido e fechado: aceito, sem quirks ---
{
  const file = binaryStl(TETRA);
  const result = parseStlForImport(file, 'tetra.stl');
  check('upload: binário válido aceito', result.stats.triangles === 4 && result.formatLabel === 'STL binário');
  check('upload: watertight detectado', result.audit.boundaryLoops === 0);
  check('upload: sem quirks no modelo limpo', result.quirks.length === 0, result.quirks.join('; '));
}

// --- 2. Binário truncado: erro específico, sem mencionar redução ---
{
  const file = binaryStl(TETRA).subarray(0, 84 + 4 * 50 - 25);
  let message = '';
  try {
    parseStlForImport(file, 'corte.stl');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('upload: truncado rejeitado com motivo', /truncado/i.test(message), message.slice(0, 80));
  check('upload: erro não fala de redução', !/redução|reduction|otimiz/i.test(message));
}

// --- 3. Contagem zero: erro específico ---
{
  const file = binaryStl([]);
  let message = '';
  try {
    parseStlForImport(file, 'vazio.stl');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('upload: zero faces rejeitado', /sem triângulos|vazio/i.test(message), message.slice(0, 60));
}

// --- 4. ASCII válido (maiúsculas, espaços irregulares): aceito ---
{
  const text = 'SOLID teste\nFACET NORMAL 0 0 1\n  OUTER LOOP\nVERTEX 0 0 0\nvertex  1  0  0\nVertex 0 1 0\nENDLOOP\nENDFACET\nENDSOLID teste\n';
  const result = parseStlForImport(new TextEncoder().encode(text), 'tri.stl');
  check('upload: ASCII robusto aceito', result.stats.triangles === 1 && result.formatLabel === 'STL ASCII');
}

// --- 5. ASCII lixo: erro específico ---
{
  const text = 'solid nada aqui\napenas texto sem facets\nendsolid\n';
  let message = '';
  try {
    parseStlForImport(new TextEncoder().encode(text), 'lixo.stl');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('upload: ASCII inválido rejeitado', /inválido|sem triângulos/i.test(message), message.slice(0, 60));
}

// --- 6. Arquivo vazio: erro específico ---
{
  let message = '';
  try {
    parseStlForImport(new Uint8Array(0), 'vazio.stl');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('upload: vazio rejeitado', /vazio/i.test(message), message);
}

// --- 7. Bytes aleatórios: inválido (não "não pôde ser lido" por redução) ---
{
  const rnd = new Uint8Array(512).map((_, i) => (i * 37 + 11) % 251);
  let message = '';
  try {
    parseStlForImport(rnd, 'lixo.stl');
  } catch (error) {
    message = error instanceof Error ? error.message : '';
  }
  check('upload: lixo rejeitado com motivo', message.length > 0, message.slice(0, 60));
  check('upload: lixo não culpa redução', !/redução/i.test(message));
}

// --- 8. REGRA DE OURO: malha aberta é ACEITA (com quirks), não recusada ---
{
  const open: Array<[[number, number, number], [number, number, number], [number, number, number]]> = [
    [[0, 0, 0], [1, 0, 0], [1, 1, 0]],
    [[0, 0, 0], [1, 1, 0], [0, 1, 0]],
  ];
  const result = parseStlForImport(binaryStl(open), 'plano.stl');
  check('upload: malha aberta ACEITA', result.stats.triangles === 2);
  check('upload: abertura vira quirk (estratégia especial)', result.quirks.some((q) => /abertura/i.test(q)), result.quirks.join('; '));
}

// --- 9. Não-STL sinaliza fallback (não erro fatal) ---
{
  const obj = new TextEncoder().encode('v 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n');
  let isNotStl = false;
  try {
    parseStlForImport(obj, 'modelo.obj');
  } catch (error) {
    isNotStl = error instanceof NotStlError;
  }
  check('upload: não-STL usa fallback', isNotStl);
}

// --- 10. Classificador de erro: redução ≠ leitura ---
{
  check('erro: código ZERO_REDUCTION', isZeroReductionError({ type: 'error', code: 'ZERO_REDUCTION', message: 'x' }));
  check('erro: mensagem legada', isZeroReductionError({ type: 'error', message: 'Nenhuma redução segura foi possível.' }));
  check('erro: corrompido é fatal', !isZeroReductionError({ type: 'error', message: 'STL binário truncado.' }));
  check('erro: code UNREADABLE é fatal', !isZeroReductionError({ type: 'error', code: 'UNREADABLE', message: 'Arquivo STL inválido.' }));
}

console.log(failures === 0 ? '\nTODOS OS TESTES PASSARAM' : `\n${failures} TESTE(S) FALHARAM`);
process.exit(failures === 0 ? 0 : 1);
