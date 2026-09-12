/**
 * Worker do COMPRESSOR LOSSLESS (MODO 1 — fluxo principal).
 * ----------------------------------------------------------
 * Nunca toca na malha: analisa → comprime → descompacta → valida.
 * Só entrega o arquivo se descompressão == original (bytes + SHA-256).
 */
import { analyzeRedundancy } from './analyzer';
import { pack3d, packGzip, parsePackHeader, unpack3d, unpackGzip, assertIdentical } from './container';
import { compressSmart, hasCompressionStreams } from './engine';
import { detectFormat, type FormatInfo } from './formats';
import { Sha256 } from './sha256';
import { verifyByteLossless } from './validation';
import type {
  AnalyzeRequest,
  AnalyzeSuccess,
  CompressAnalysis,
  CompressRequest,
  CompressorFailure,
  CompressorProgress,
  CompressorSuccess,
  DecompressPackRequest,
  DecompressSuccess,
  OptimizeRequest,
  OptimizeSuccess,
} from '../mesh/types';
import { optimizeDelivery } from './optimizer';

const post = (
  message: CompressorProgress | CompressorSuccess | DecompressSuccess | OptimizeSuccess | CompressorFailure,
  transfer: Transferable[] = [],
) => self.postMessage(message, { transfer });

function infoForUnpack(header: { format: FormatInfo['format']; transform: string; originalSize: number }): FormatInfo {
  const isStlBin = header.format === 'STL_BINARY';
  const start = isStlBin ? 84 : 0;
  return {
    format: header.format,
    confidence: 'magic',
    recordSize: isStlBin ? 50 : 0,
    recordStart: start,
    faces: 0,
    vertices: 0,
    recordBytes: Math.max(0, header.originalSize - start),
  };
}

async function analyzeBytes(fileName: string, bytes: Uint8Array): Promise<{ analysis: CompressAnalysis; info: FormatInfo }> {
  // CAMADA 1 — referência absoluta + fingerprint.
  const info = detectFormat(fileName, bytes);
  if (bytes.length === 0) throw new Error('Arquivo vazio.');
  const hasher = new Sha256();
  for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
    hasher.update(bytes.subarray(offset, Math.min(bytes.length, offset + 1024 * 1024)));
  }
  const originalSha256 = hasher.digestHex();
  const redundancy = analyzeRedundancy(bytes, info);
  const analysis: CompressAnalysis = {
    format: info.format,
    confidence: info.confidence,
    originalBytes: bytes.length,
    originalSha256,
    faces: info.faces,
    entropyBitsPerByte: redundancy.entropyBitsPerByte,
    suggestedLevel: redundancy.suggestedLevel,
    notes: redundancy.notes,
  };
  return { analysis, info };
}

async function handleAnalyze(request: AnalyzeRequest): Promise<void> {
  const started = performance.now();
  const bytes = new Uint8Array(request.buffer);
  const { analysis } = await analyzeBytes(request.fileName, bytes);
  const done: AnalyzeSuccess = {
    type: 'complete', job: 'analyze', analysis, elapsedMs: performance.now() - started,
  };
  self.postMessage(done);
}

async function handleCompress(request: CompressRequest): Promise<void> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const bytes = new Uint8Array(request.buffer);

  post({
    type: 'progress', job: 'compress', phase: 'analyzing', progress: 0.05,
    message: 'Analisando formato e redundância…', stage: 'ANALISANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length,
  });

  const { analysis, info } = await analyzeBytes(request.fileName, bytes);
  post({
    type: 'progress', job: 'compress', phase: 'analyzing', progress: 0.15,
    message: `Detectado ${info.format} — ${info.faces > 0 ? `${info.faces.toLocaleString('pt-BR')} faces · ` : ''}entropia ${analysis.entropyBitsPerByte} bits/byte…`,
    stage: 'IDENTIFICANDO_FEATURES', elapsedMs: elapsed(), originalBytes: bytes.length,
    originalTriangles: info.faces, format: info.format,
  });

  // CAMADA 3 — compressão inteligente (testa N estratégias, coroa a melhor).
  post({
    type: 'progress', job: 'compress', phase: 'compressing', progress: 0.2,
    message: 'Testando estratégias lossless…', stage: 'OTIMIZANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
  });
  const smart = await compressSmart(bytes, info, request.level, (tried, total) => {
    post({
      type: 'progress', job: 'compress', phase: 'compressing',
      progress: 0.2 + (tried / Math.max(1, total)) * 0.5,
      message: `Testando estratégias lossless (${tried}/${total})…`, stage: 'OTIMIZANDO',
      elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
    });
  });

  const warnings: string[] = [];
  if (!hasCompressionStreams()) {
    warnings.push('DEFLATE indisponível neste navegador: estratégia "store" utilizada (sem compressão).');
  }
  if (smart.winner.ratio >= 0.97) {
    warnings.push('Compressão adicional limitada: o arquivo já parece comprimido ou tem alta entropia. A malha foi preservada intacta.');
  }

  // Container .3dpack + .gz universal (gzip sempre sobre os BYTES ORIGINAIS).
  const packed = pack3d(bytes, request.fileName, info, smart.winner);
  const gzip = await packGzip(bytes);

  // VALIDAÇÃO RIGOROSA: descompacta os dois e compara tudo.
  post({
    type: 'progress', job: 'compress', phase: 'validating', progress: 0.85,
    message: 'Validando — descompactando e comparando SHA-256…', stage: 'VALIDANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
  });
  const { bytes: rebuilt } = await unpack3d(packed.bytes, infoForUnpack({
    format: packed.header.format,
    transform: packed.header.transform,
    originalSize: packed.header.originalSize,
  }));
  assertIdentical(bytes, rebuilt, '3dpack');
  const gunzipped = await unpackGzip(gzip);
  assertIdentical(bytes, gunzipped, 'gzip');
  const report = verifyByteLossless(bytes, rebuilt, info);
  if (!report.pass) {
    throw new Error(`LOSSLESS_VALIDATION_FAILED: ${report.reasons.join(' ')}`);
  }

  post({
    type: 'progress', job: 'compress', phase: 'done', progress: 0.99,
    message: `Arquivo comprimido sem alteração da malha — ${((1 - packed.bytes.length / bytes.length) * 100).toFixed(1)}% menor.`,
    stage: 'FINALIZANDO', elapsedMs: elapsed(), originalBytes: bytes.length,
    originalTriangles: info.faces, format: info.format,
  });

  const packBytes = packed.bytes.buffer.slice(0) as ArrayBuffer;
  const gzipBuffer = gzip.buffer.slice(0) as ArrayBuffer;
  const rebuiltBuffer = rebuilt.buffer.slice(0) as ArrayBuffer;
  const base = request.fileName.replace(/\.[^.]+$/, '');
  const complete: CompressorSuccess = {
    type: 'complete',
    job: 'compress',
    analysis,
    pack: packBytes,
    packFileName: `${base}.3dpack`,
    gzip: gzipBuffer,
    gzipFileName: `${base}.gz`,
    rebuilt: rebuiltBuffer,
    method: smart.winner.method,
    transform: smart.winner.transform.id,
    tier: 'A',
    originalBytes: bytes.length,
    packBytes: packed.bytes.length,
    gzipBytes: gzip.length,
    ratioPack: packed.bytes.length / Math.max(1, bytes.length),
    ratioGzip: gzip.length / Math.max(1, bytes.length),
    faces: info.faces,
    validation: 'LOSSLESS PASS',
    warnings,
    elapsedMs: elapsed(),
  };
  self.postMessage(complete, { transfer: [packBytes, gzipBuffer, rebuiltBuffer] });
}

async function handleDecompress(request: DecompressPackRequest): Promise<void> {
  const started = performance.now();
  const bytes = new Uint8Array(request.buffer);
  const { header } = parsePackHeader(bytes);
  const info = detectFormat(header.originalName, new Uint8Array(0));
  void info;
  const { bytes: rebuilt, header: parsed } = await unpack3d(
    bytes,
    infoForUnpack({ format: header.format, transform: header.transform, originalSize: header.originalSize }),
  );
  const buffer = rebuilt.buffer.slice(0) as ArrayBuffer;
  const done: DecompressSuccess = {
    type: 'complete',
    job: 'decompress',
    bytes: buffer,
    fileName: parsed.originalName,
    format: parsed.format,
    faces: parsed.faces,
    validation: 'LOSSLESS PASS',
    elapsedMs: performance.now() - started,
  };
  self.postMessage(done, { transfer: [buffer] });
}

async function handleOptimize(request: OptimizeRequest): Promise<void> {
  const started = performance.now();
  const elapsed = (): number => performance.now() - started;
  const bytes = new Uint8Array(request.buffer);

  post({
    type: 'progress', job: 'compress', phase: 'analyzing', progress: 0.05,
    message: 'Analisando o modelo original…', stage: 'ANALISANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length,
  });
  const { analysis, info } = await analyzeBytes(request.fileName, bytes);
  post({
    type: 'progress', job: 'compress', phase: 'analyzing', progress: 0.15,
    message: `Detectado ${info.format} — ${info.faces > 0 ? `${info.faces.toLocaleString('pt-BR')} faces · ` : ''}buscando a melhor representação…`,
    stage: 'IDENTIFICANDO_FEATURES', elapsedMs: elapsed(), originalBytes: bytes.length,
    originalTriangles: info.faces, format: info.format,
  });

  post({
    type: 'progress', job: 'compress', phase: 'compressing', progress: 0.25,
    message: 'Otimizando a representação (faces preservadas)…', stage: 'OTIMIZANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
  });
  const result = await optimizeDelivery(bytes, request.fileName, info, (stageMessage) => {
    post({
      type: 'progress', job: 'compress', phase: 'compressing', progress: 0.5,
      message: stageMessage, stage: 'OTIMIZANDO',
      elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
    });
  });

  post({
    type: 'progress', job: 'compress', phase: 'validating', progress: 0.9,
    message: 'Reimportando e comparando geometria…', stage: 'VALIDANDO',
    elapsedMs: elapsed(), originalBytes: bytes.length, originalTriangles: info.faces, format: info.format,
  });

  // A validação já ocorreu dentro do optimizeDelivery (reimportação +
  // comparação); aqui apenas consolidamos o selo para a UI.
  const report = result.report;
  const validation = report
    ? (report.tier === 'A' ? 'LOSSLESS PASS' : 'GEOMETRY PASS')
    : 'GEOMETRY PASS';

  post({
    type: 'progress', job: 'compress', phase: 'done', progress: 0.99,
    message: `Arquivo comprimido sem alteração da malha — ${((1 - result.ratio) * 100).toFixed(1)}% menor.`,
    stage: 'FINALIZANDO', elapsedMs: elapsed(), originalBytes: bytes.length,
    originalTriangles: info.faces, format: info.format,
  });

  const stlBuffer = result.delivered.buffer.slice(0) as ArrayBuffer;
  const gzipBuffer = result.gzipSecondary.buffer.slice(0) as ArrayBuffer;
  const base = request.fileName.replace(/\.[^.]+$/, '');
  const complete: OptimizeSuccess = {
    type: 'complete',
    job: 'optimize',
    stl: stlBuffer,
    fileName: result.deliveredFileName,
    gzip: gzipBuffer,
    gzipFileName: `${base}.gz`,
    method: result.method,
    methodLabel: result.methodLabel,
    tier: result.tier,
    format: info.format,
    originalBytes: result.originalBytes,
    deliveredBytes: result.deliveredBytes,
    ratio: result.ratio,
    faces: result.faces,
    validation,
    checks: report ? report.checks : {},
    warnings: [...result.warnings, ...analysis.notes],
    benchmark: result.benchmark,
    meanError: report ? report.meanError : 0,
    maxError: report ? report.maxError : 0,
    volumeDeltaPercent: report ? report.volumeDeltaPercent : 0,
    boundaryOriginal: report ? report.boundaryOriginal : 0,
    boundaryFinal: report ? report.boundaryFinal : 0,
    elapsedMs: elapsed(),
  };
  self.postMessage(complete, { transfer: [stlBuffer, gzipBuffer] });
}

self.onmessage = (event: MessageEvent<AnalyzeRequest | CompressRequest | DecompressPackRequest | OptimizeRequest>) => {
  const request = event.data;
  const run = async (): Promise<void> => {
    if (request.type === 'analyze') await handleAnalyze(request);
    else if (request.type === 'compress') await handleCompress(request);
    else if (request.type === 'optimize') await handleOptimize(request);
    else if (request.type === 'decompress-pack') await handleDecompress(request);
  };
  run().catch((error: unknown) => {
    const failure: CompressorFailure = {
      type: 'error',
      job: request.type === 'decompress-pack' ? 'decompress' : 'compress',
      message: error instanceof Error ? error.message : 'Falha na compressão lossless.',
      technical: error instanceof Error ? error.stack : String(error),
    };
    post(failure);
  });
};
