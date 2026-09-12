/**
 * CAMADA 2 — IDENTIFICAÇÃO DO FORMATO (FormatDetector)
 * ----------------------------------------------------
 * Detecta pelo CONTEÚDO (magic bytes + estrutura), nunca só pela extensão.
 * Arquitetura modular: cada formato declara como detectar, contar
 * faces/vértices e qual a granularidade natural de redundância.
 */

export type MeshFileFormat =
  | 'STL_BINARY'
  | 'STL_ASCII'
  | 'OBJ'
  | 'PLY_ASCII'
  | 'PLY_BINARY_LE'
  | 'PLY_BINARY_BE'
  | 'OFF'
  | 'GLB'
  | 'GLTF'
  | '3MF'
  | 'DAE'
  | 'FBX'
  | 'UNKNOWN';

export interface FormatInfo {
  format: MeshFileFormat;
  /** Confiança da detecção: 'magic' (bytes) | 'structure' (conteúdo) | 'hint' (extensão). */
  confidence: 'magic' | 'structure' | 'hint';
  /** Tamanho do registro natural para shuffle (0 = sem estrutura fixa). */
  recordSize: number;
  /** Offset onde começam os registros (ex. STL binário: header 84). */
  recordStart: number;
  faces: number;
  vertices: number;
  /** Tamanho em bytes coberto pelos registros (para análise de entropia). */
  recordBytes: number;
}

const textDecoder = new TextDecoder();

function headText(bytes: Uint8Array, length = 512): string {
  return textDecoder.decode(bytes.subarray(0, Math.min(length, bytes.length))).toLowerCase();
}

function countAsciiFacets(sample: string): number {
  let count = 0;
  let index = sample.indexOf('facet');
  while (index >= 0) {
    count += 1;
    index = sample.indexOf('facet', index + 5);
  }
  return count;
}

/**
 * Conta faces/vértices de forma LEVE (sem three.js): o compressor não pode
 * depender do parser pesado — e a validação usa este contador como parser
 * INDEPENDENTE do caminho de análise.
 */
export function quickCount(bytes: Uint8Array, format: MeshFileFormat): { faces: number; vertices: number } {
  try {
    if (format === 'STL_BINARY' && bytes.length >= 84) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const faces = view.getUint32(80, true);
      if (faces > 0 && 84 + faces * 50 <= bytes.length + 50) return { faces, vertices: 0 };
      return { faces: 0, vertices: 0 };
    }
    if (format === 'STL_ASCII') {
      const text = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 32 * 1024 * 1024)));
      const facets = (text.match(/facet\s+normal/gi) ?? []).length;
      const vertices = (text.match(/^\s*vertex\s+/gim) ?? []).length;
      return { faces: facets, vertices: Math.floor(vertices / 3) > 0 ? vertices : 0 };
    }
    if (format === 'OBJ') {
      const text = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 64 * 1024 * 1024)));
      let v = 0; let f = 0;
      for (const line of text.split('\n')) {
        if (line.startsWith('v ')) v += 1;
        else if (line.startsWith('f ')) f += 1;
      }
      return { faces: f, vertices: v };
    }
    if (format === 'OFF') {
      const text = textDecoder.decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
      const m = text.replace(/^[ \t]*#[^\n]*\n/mg, '').match(/(?:off|c?off)[\s]+(\d+)[\s]+(\d+)/i);
      if (m) return { faces: Number(m[2]), vertices: Number(m[1]) };
      return { faces: 0, vertices: 0 };
    }
  } catch {
    return { faces: 0, vertices: 0 };
  }
  return { faces: 0, vertices: 0 };
}

export function detectFormat(fileName: string, bytes: Uint8Array): FormatInfo {
  const extension = fileName.split('.').pop()?.toLowerCase() ?? '';
  const fallback: FormatInfo = {
    format: 'UNKNOWN', confidence: 'hint', recordSize: 0, recordStart: 0,
    faces: 0, vertices: 0, recordBytes: 0,
  };

  if (bytes.length >= 4) {
    // ZIP (3MF é um container ZIP): PK\x03\x04.
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05 || bytes[2] === 0x07)) {
      const head = headText(bytes, 2048);
      const format: MeshFileFormat = head.includes('[content_types]') || extension === '3mf' ? '3MF' : 'UNKNOWN';
      return { ...fallback, format, confidence: 'magic', recordBytes: bytes.length };
    }
    // GLB: magic "glTF" + versão.
    if (bytes[0] === 0x67 && bytes[1] === 0x6c && bytes[2] === 0x54 && bytes[3] === 0x46) {
      return { ...fallback, format: 'GLB', confidence: 'magic', recordBytes: bytes.length };
    }
    // FBX binário: "Kaydara FBX Binary".
    if (headText(bytes, 64).includes('kaydara fbx binary')) {
      return { ...fallback, format: 'FBX', confidence: 'magic', recordBytes: bytes.length };
    }
  }

  // STL binário: uint32 em offset 80 casa com o tamanho do arquivo.
  if (bytes.length >= 84) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const claimed = view.getUint32(80, true);
    if (claimed > 0 && 84 + claimed * 50 === bytes.length) {
      return {
        format: 'STL_BINARY', confidence: 'magic', recordSize: 50, recordStart: 84,
        faces: claimed, vertices: 0, recordBytes: bytes.length - 84,
      };
    }
  }

  const head = headText(bytes, 1024);
  // PLY: primeira linha "ply".
  if (head.startsWith('ply')) {
    const headerEnd = headText(bytes, 64 * 1024).indexOf('end_header');
    const headerText = headText(bytes, Math.min(bytes.length, 64 * 1024));
    const formatLine = headerText.match(/format\s+(\S+)/)?.[1] ?? '';
    const vertexCount = Number(headerText.match(/element\s+vertex\s+(\d+)/)?.[1] ?? 0);
    const faceCount = Number(headerText.match(/element\s+face\s+(\d+)/)?.[1] ?? 0);
    if (formatLine === 'ascii') {
      return { ...fallback, format: 'PLY_ASCII', confidence: 'magic', faces: faceCount, vertices: vertexCount, recordBytes: bytes.length };
    }
    if (formatLine === 'binary_little_endian' || formatLine === 'binary_big_endian') {
      const le = formatLine === 'binary_little_endian';
      const start = headerEnd >= 0 ? headerText.indexOf('end_header') + 'end_header'.length + 1 : 0;
      return {
        ...fallback, format: le ? 'PLY_BINARY_LE' : 'PLY_BINARY_BE', confidence: 'magic',
        faces: faceCount, vertices: vertexCount, recordStart: start,
        recordBytes: Math.max(0, bytes.length - start),
      };
    }
  }

  // STL ASCII: "solid" + "facet normal".
  if (/^\s*solid/.test(head) && bytes.length > 128) {
    const probe = headText(bytes, 8192);
    if (probe.includes('facet') && probe.includes('vertex')) {
      const { faces } = quickCount(bytes, 'STL_ASCII');
      return { ...fallback, format: 'STL_ASCII', confidence: 'structure', faces, vertices: 0, recordBytes: bytes.length };
    }
  }

  // OBJ / OFF / DAE / glTF-texto por estrutura.
  const probe = headText(bytes, 4096);
  if (/^v\s+[-\d.]/m.test(probe) && /^f\s+\d/m.test(probe)) {
    const { faces, vertices } = quickCount(bytes, 'OBJ');
    return { ...fallback, format: 'OBJ', confidence: 'structure', faces, vertices, recordBytes: bytes.length };
  }
  if (/^(solid\s+)?off\b/.test(head) || /^\s*(off|coff)\b/.test(head)) {
    const { faces, vertices } = quickCount(bytes, 'OFF');
    return { ...fallback, format: 'OFF', confidence: 'structure', faces, vertices, recordBytes: bytes.length };
  }
  if (probe.includes('<collada')) return { ...fallback, format: 'DAE', confidence: 'structure', recordBytes: bytes.length };
  if (probe.trimStart().startsWith('{') && probe.includes('"asset"') && probe.includes('gltf')) {
    return { ...fallback, format: 'GLTF', confidence: 'structure', recordBytes: bytes.length };
  }

  // Último recurso: dica da extensão (sem contagem confiável).
  const hinted: Record<string, MeshFileFormat> = {
    stl: 'STL_BINARY', obj: 'OBJ', ply: 'PLY_ASCII', off: 'OFF',
    glb: 'GLB', gltf: 'GLTF', '3mf': '3MF', dae: 'DAE', fbx: 'FBX',
  };
  const hint = hinted[extension];
  if (hint) {
    const { faces, vertices } = hint === 'STL_ASCII' || hint === 'OBJ' || hint === 'OFF' ? quickCount(bytes, hint) : { faces: 0, vertices: 0 };
    return { ...fallback, format: hint, confidence: 'hint', faces, vertices, recordBytes: bytes.length };
  }
  return { ...fallback, recordBytes: bytes.length };
}
