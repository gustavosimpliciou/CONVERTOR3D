/**
 * MeshAnalyzer — ANÁLISE DA REDUNDÂNCIA DOS DADOS
 * ------------------------------------------------
 * Antes de escolher o algoritmo, mede:
 *  - entropia de Shannon (amostrada, 0..8 bits/byte);
 *  - taxa de bytes repetidos em janela curta (RLE-friendly?);
 *  - zeros e padrões de float (STL binário tem muito 0x00 em expoentes);
 *  - compressibilidade estimada → nível sugerido (FAST/BALANCED/MAX).
 *
 * Tudo em O(amostra), nunca O(n²): arquivos de 100MB+ analisam em ms.
 */

import type { FormatInfo } from './formats';

export interface RedundancyReport {
  entropyBitsPerByte: number;
  repeatRate: number;
  zeroRate: number;
  asciiWhitespaceRate: number;
  /** 0..1 — quanto menor a entropia, maior o potencial. */
  compressibilityScore: number;
  suggestedLevel: 'fast' | 'balanced' | 'max';
  notes: string[];
}

const SAMPLES = 8;
const SAMPLE_SIZE = 65536;

function sampleOffsets(length: number): number[] {
  if (length <= SAMPLE_SIZE) return [0];
  const offsets: number[] = [];
  for (let i = 0; i < SAMPLES; i += 1) {
    offsets.push(Math.floor(((length - SAMPLE_SIZE) * i) / (SAMPLES - 1)));
  }
  return offsets;
}

export function analyzeRedundancy(bytes: Uint8Array, info: FormatInfo): RedundancyReport {
  const notes: string[] = [];
  if (bytes.length === 0) {
    return {
      entropyBitsPerByte: 8, repeatRate: 0, zeroRate: 0, asciiWhitespaceRate: 0,
      compressibilityScore: 0, suggestedLevel: 'fast', notes: ['Arquivo vazio.'],
    };
  }
  const histogram = new Uint32Array(256);
  let total = 0;
  let repeats = 0;
  let zeros = 0;
  let whitespace = 0;
  let previous = -1;
  for (const offset of sampleOffsets(bytes.length)) {
    const end = Math.min(bytes.length, offset + SAMPLE_SIZE);
    for (let i = offset; i < end; i += 1) {
      const b = bytes[i];
      histogram[b] += 1;
      total += 1;
      if (b === 0) zeros += 1;
      if (b === 9 || b === 10 || b === 13 || b === 32) whitespace += 1;
      if (b === previous) repeats += 1;
      previous = b;
    }
  }
  let entropy = 0;
  for (let i = 0; i < 256; i += 1) {
    if (histogram[i] === 0) continue;
    const p = histogram[i] / total;
    entropy -= p * Math.log2(p);
  }
  const repeatRate = total > 0 ? repeats / total : 0;
  const zeroRate = total > 0 ? zeros / total : 0;
  const asciiWhitespaceRate = total > 0 ? whitespace / total : 0;

  // Escore 0..1: entropia baixa + repetição + zeros + texto verboso = alto.
  const compressibilityScore = Math.max(
    0,
    Math.min(1, (8 - entropy) / 8 + repeatRate * 1.5 + zeroRate * 0.8 + asciiWhitespaceRate * 0.9),
  );

  if (info.format === 'STL_BINARY') notes.push('STL binário: registros fixos de 50 bytes favorecem shuffle + DEFLATE.');
  if (info.format === 'STL_ASCII') notes.push('STL ASCII: texto verboso — conversão binária (nível B) ou DEFLATE direto (nível A).');
  if (info.format === '3MF') notes.push('3MF já é um ZIP: compressão adicional tende a ser limitada.');
  if (zeroRate > 0.15) notes.push(`Alta taxa de zeros (${(zeroRate * 100).toFixed(1)}%): típico de floats 3D.`);
  if (repeatRate > 0.1) notes.push(`Repetição local alta (${(repeatRate * 100).toFixed(1)}%).`);
  if (entropy > 7.5) notes.push('Entropia próxima do máximo: arquivo já comprimido ou aleatório — ganho limitado.');

  const suggestedLevel =
    compressibilityScore > 0.55 ? 'max' : compressibilityScore > 0.3 ? 'balanced' : 'fast';

  return {
    entropyBitsPerByte: Math.round(entropy * 100) / 100,
    repeatRate: Math.round(repeatRate * 10000) / 10000,
    zeroRate: Math.round(zeroRate * 10000) / 10000,
    asciiWhitespaceRate: Math.round(asciiWhitespaceRate * 10000) / 10000,
    compressibilityScore: Math.round(compressibilityScore * 100) / 100,
    suggestedLevel,
    notes,
  };
}
