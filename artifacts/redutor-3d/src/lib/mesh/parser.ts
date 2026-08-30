import { Mesh, Object3D, Vector3 } from 'three';
import { ColladaLoader } from 'three/examples/jsm/loaders/ColladaLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { buildStats, calculateBounds, normalizeTriangles } from './geometry';
import type { MeshData, MeshFormat } from './types';

const decoder = new TextDecoder();

function extensionFormat(name: string): MeshFormat | undefined {
  const extension = name.split('.').pop()?.toLowerCase();
  if (extension === 'stl') return 'STL';
  if (extension === 'obj') return 'OBJ';
  if (extension === 'ply') return 'PLY';
  if (extension === 'off') return 'OFF';
  if (extension === 'glb') return 'GLB';
  if (extension === 'gltf') return 'GLTF';
  if (extension === 'fbx') return 'FBX';
  if (extension === 'dae') return 'DAE';
  return undefined;
}

function cleanLines(text: string) {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

function parseBinaryStl(buffer: ArrayBuffer): MeshData | null {
  if (buffer.byteLength < 84) return null;
  const view = new DataView(buffer);
  const triangles = view.getUint32(80, true);
  if (triangles === 0 || triangles > (buffer.byteLength - 84) / 50) return null;
  const positions: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();
  const readVertex = (offset: number) => {
    const x = view.getFloat32(offset, true);
    const y = view.getFloat32(offset + 4, true);
    const z = view.getFloat32(offset + 8, true);
    if (![x, y, z].every(Number.isFinite)) throw new Error('Valores inválidos no STL.');
    const key = `${x}|${y}|${z}`;
    const existing = vertexMap.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(x, y, z);
    vertexMap.set(key, index);
    return index;
  };
  for (let i = 0; i < triangles; i += 1) {
    const base = 84 + i * 50;
    indices.push(readVertex(base + 12), readVertex(base + 24), readVertex(base + 36));
  }
  const mesh = normalizeTriangles(
    positions,
    Array.from({ length: indices.length / 3 }, (_, i) => indices.slice(i * 3, i * 3 + 3)),
    'STL',
  );
  return buildStats(mesh).triangles > 0 ? mesh : null;
}

function parseAsciiStl(text: string): MeshData | null {
  const vertices: number[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = line.trim().match(/^vertex\s+([^\s]+)\s+([^\s]+)\s+([^\s]+)/i);
    if (!match) continue;
    const values = match.slice(1).map(Number);
    if (!values.every(Number.isFinite)) throw new Error('Valores inválidos no STL.');
    vertices.push(...values);
  }
  if (vertices.length < 9 || vertices.length % 9 !== 0) return null;
  const triangles = Array.from({ length: vertices.length / 9 }, (_, triangle) => [
    triangle * 3,
    triangle * 3 + 1,
    triangle * 3 + 2,
  ]);
  return normalizeTriangles(vertices, triangles, 'STL');
}

function parseObj(text: string): MeshData {
  const positions: number[] = [];
  const triangles: number[][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const parts = line.split(/\s+/);
    if (parts[0].toLowerCase() === 'v' && parts.length >= 4) {
      const vertex = parts.slice(1, 4).map(Number);
      if (vertex.every(Number.isFinite)) positions.push(...vertex);
    } else if (parts[0].toLowerCase() === 'f' && parts.length >= 4) {
      const face = parts.slice(1).map((part) => {
        const raw = Number(part.split('/')[0]);
        return raw < 0 ? positions.length / 3 + raw : raw - 1;
      });
      for (let i = 1; i < face.length - 1; i += 1) {
        triangles.push([face[0], face[i], face[i + 1]]);
      }
    }
  }
  return normalizeTriangles(positions, triangles, 'OBJ');
}

type PlyProperty = { name: string; type: string; list?: { countType: string; itemType: string } };
type PlyElement = { name: string; count: number; properties: PlyProperty[] };

const PLY_TYPE_SIZES: Record<string, number> = {
  char: 1,
  int8: 1,
  uchar: 1,
  uint8: 1,
  short: 2,
  int16: 2,
  ushort: 2,
  uint16: 2,
  int: 4,
  int32: 4,
  uint: 4,
  uint32: 4,
  float: 4,
  float32: 4,
  double: 8,
  float64: 8,
};

function plyScalar(view: DataView, offset: number, type: string, littleEndian: boolean): number {
  switch (type.toLowerCase()) {
    case 'char':
    case 'int8':
      return view.getInt8(offset);
    case 'uchar':
    case 'uint8':
      return view.getUint8(offset);
    case 'short':
    case 'int16':
      return view.getInt16(offset, littleEndian);
    case 'ushort':
    case 'uint16':
      return view.getUint16(offset, littleEndian);
    case 'int':
    case 'int32':
      return view.getInt32(offset, littleEndian);
    case 'uint':
    case 'uint32':
      return view.getUint32(offset, littleEndian);
    case 'float':
    case 'float32':
      return view.getFloat32(offset, littleEndian);
    case 'double':
    case 'float64':
      return view.getFloat64(offset, littleEndian);
    default:
      throw new Error(`Tipo PLY não suportado: ${type}.`);
  }
}

function parsePly(text: string, bytes: Uint8Array): MeshData {
  const headerEnd = text.toLowerCase().indexOf('end_header');
  if (headerEnd < 0) throw new Error('Cabeçalho PLY inválido.');
  const headerLines = text.slice(0, headerEnd).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (headerLines[0]?.toLowerCase() !== 'ply') throw new Error('Arquivo PLY inválido.');

  const formatLine = headerLines.find((line) => line.toLowerCase().startsWith('format '))?.split(/\s+/);
  const format = formatLine?.[1];
  const elements: PlyElement[] = [];
  let current: PlyElement | undefined;
  for (const line of headerLines.slice(1)) {
    const parts = line.split(/\s+/);
    if (parts[0] === 'element' && parts.length >= 3) {
      current = { name: parts[1].toLowerCase(), count: Number(parts[2]), properties: [] };
      elements.push(current);
    } else if (parts[0] === 'property' && current) {
      if (parts[1] === 'list' && parts.length >= 5) {
        current.properties.push({
          name: parts[4].toLowerCase(),
          type: parts[3],
          list: { countType: parts[2], itemType: parts[3] },
        });
      } else if (parts.length >= 3) {
        current.properties.push({ name: parts[2].toLowerCase(), type: parts[1] });
      }
    }
  }
  const vertexElement = elements.find((element) => element.name === 'vertex');
  const faceElement = elements.find((element) => element.name === 'face');
  if (!vertexElement || !faceElement) throw new Error('PLY precisa conter vértices e faces.');
  if (format === 'ascii') {
    const start = text.slice(headerEnd).replace(/^end_header[^\r\n]*(?:\r\n|\n|\r)?/i, '');
    const lines = cleanLines(start);
    const positions: number[] = [];
    let cursor = 0;
    for (let i = 0; i < vertexElement.count; i += 1) {
      const values = lines[cursor++].split(/\s+/);
      const byName = new Map(vertexElement.properties.filter((property) => !property.list).map((property, index) => [property.name, Number(values[index])] as const));
      positions.push(byName.get('x') ?? Number(values[0]), byName.get('y') ?? Number(values[1]), byName.get('z') ?? Number(values[2]));
    }
    const triangles: number[][] = [];
    for (let i = 0; i < faceElement.count; i += 1) {
      const values = lines[cursor++].split(/\s+/).map(Number);
      const face = values.slice(1, values[0] + 1);
      for (let j = 1; j < face.length - 1; j += 1) triangles.push([face[0], face[j], face[j + 1]]);
    }
    return normalizeTriangles(positions, triangles, 'PLY');
  }

  if (format !== 'binary_little_endian' && format !== 'binary_big_endian') {
    throw new Error('Formato PLY desconhecido.');
  }
  const headerBytes = new TextEncoder().encode(text.slice(0, headerEnd));
  let dataOffset = headerBytes.length;
  while (dataOffset < bytes.length && bytes[dataOffset] !== 10 && bytes[dataOffset] !== 13) dataOffset += 1;
  while (dataOffset < bytes.length && (bytes[dataOffset] === 10 || bytes[dataOffset] === 13)) dataOffset += 1;
  const view = new DataView(bytes.buffer, bytes.byteOffset + dataOffset, bytes.byteLength - dataOffset);
  const littleEndian = format === 'binary_little_endian';
  let offset = 0;
  const positions: number[] = [];
  const faces: number[][] = [];
  for (const element of elements) {
    for (let i = 0; i < element.count; i += 1) {
      const scalars = new Map<string, number>();
      let listValues: number[] = [];
      for (const property of element.properties) {
        if (property.list) {
          const countSize = PLY_TYPE_SIZES[property.list.countType];
          if (!countSize) throw new Error(`Tipo PLY não suportado: ${property.list.countType}.`);
          const count = plyScalar(view, offset, property.list.countType, littleEndian);
          offset += countSize;
          listValues = [];
          for (let item = 0; item < count; item += 1) {
            const size = PLY_TYPE_SIZES[property.list.itemType];
            if (!size) throw new Error(`Tipo PLY não suportado: ${property.list.itemType}.`);
            listValues.push(plyScalar(view, offset, property.list.itemType, littleEndian));
            offset += size;
          }
        } else {
          const size = PLY_TYPE_SIZES[property.type];
          if (!size) throw new Error(`Tipo PLY não suportado: ${property.type}.`);
          scalars.set(property.name, plyScalar(view, offset, property.type, littleEndian));
          offset += size;
        }
      }
      if (element === vertexElement) positions.push(scalars.get('x') ?? 0, scalars.get('y') ?? 0, scalars.get('z') ?? 0);
      if (element === faceElement && listValues.length >= 3) {
        for (let j = 1; j < listValues.length - 1; j += 1) faces.push([listValues[0], listValues[j], listValues[j + 1]]);
      }
    }
  }
  return normalizeTriangles(positions, faces, 'PLY');
}

function parseOff(text: string): MeshData {
  const lines = cleanLines(text);
  const signature = lines.shift()?.toUpperCase();
  if (signature !== 'OFF' && signature !== 'COFF') throw new Error('Arquivo OFF inválido.');
  const counts = lines.shift()?.split(/\s+/).map(Number) ?? [];
  if (counts.length < 2 || !counts.slice(0, 2).every(Number.isFinite)) throw new Error('Contagem OFF inválida.');
  const positions: number[] = [];
  for (let i = 0; i < counts[0]; i += 1) positions.push(...lines[i].split(/\s+/).slice(0, 3).map(Number));
  const triangles: number[][] = [];
  for (let i = 0; i < counts[1]; i += 1) {
    const parts = lines[counts[0] + i].split(/\s+/).map(Number);
    const face = parts.slice(1, parts[0] + 1);
    for (let j = 1; j < face.length - 1; j += 1) triangles.push([face[0], face[j], face[j + 1]]);
  }
  return normalizeTriangles(positions, triangles, 'OFF');
}

type GltfJson = {
  buffers?: Array<{ uri?: string; byteLength?: number }>;
  bufferViews?: Array<{ buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }>;
  accessors?: Array<{ bufferView?: number; byteOffset?: number; componentType: number; count: number; type: string; normalized?: boolean }>;
  meshes?: Array<{ primitives?: Array<{ attributes: { POSITION?: number }; indices?: number; mode?: number }> }>;
  nodes?: Array<{ mesh?: number; children?: number[]; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[] }>;
  scenes?: Array<{ nodes?: number[] }>;
  scene?: number;
};

type Matrix = number[];

function identityMatrix(): Matrix {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

function multiplyMatrices(left: Matrix, right: Matrix): Matrix {
  const result = Array.from({ length: 16 }, () => 0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      for (let k = 0; k < 4; k += 1) result[column * 4 + row] += left[k * 4 + row] * right[column * 4 + k];
    }
  }
  return result;
}

function nodeMatrix(node: NonNullable<GltfJson['nodes']>[number]): Matrix {
  if (node.matrix?.length === 16) return node.matrix;
  const [x, y, z] = node.translation ?? [0, 0, 0];
  const [sx, sy, sz] = node.scale ?? [1, 1, 1];
  const [qx, qy, qz, qw] = node.rotation ?? [0, 0, 0, 1];
  return [
    (1 - 2 * (qy * qy + qz * qz)) * sx, (2 * (qx * qy + qz * qw)) * sx, (2 * (qx * qz - qy * qw)) * sx, 0,
    (2 * (qx * qy - qz * qw)) * sy, (1 - 2 * (qx * qx + qz * qz)) * sy, (2 * (qy * qz + qx * qw)) * sy, 0,
    (2 * (qx * qz + qy * qw)) * sz, (2 * (qy * qz - qx * qw)) * sz, (1 - 2 * (qx * qx + qy * qy)) * sz, 0,
    x, y, z, 1,
  ];
}

function transformPoint(matrix: Matrix, x: number, y: number, z: number): [number, number, number] {
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14],
  ];
}

function base64Bytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function parseGltf(buffer: ArrayBuffer, format: 'GLB' | 'GLTF'): MeshData {
  let json: GltfJson | undefined;
  const binaryBuffers: Uint8Array[] = [];
  if (format === 'GLB') {
    const view = new DataView(buffer);
    if (buffer.byteLength < 20 || view.getUint32(0, true) !== 0x46546c67) throw new Error('Cabeçalho GLB inválido.');
    let offset = 12;
    while (offset + 8 <= buffer.byteLength) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      if (offset + 8 + length > buffer.byteLength) throw new Error('Chunk GLB inválido.');
      const chunk = new Uint8Array(buffer, offset + 8, length);
      if (type === 0x4e4f534a) json = JSON.parse(decoder.decode(chunk));
      if (type === 0x004e4942) binaryBuffers.push(chunk);
      offset += 8 + length;
    }
  } else {
    const parsed = JSON.parse(decoder.decode(buffer)) as GltfJson;
    json = parsed;
    for (const source of parsed.buffers ?? []) {
      if (!source.uri?.startsWith('data:')) throw new Error('GLTF com buffer externo: envie um GLB ou incorpore os buffers como data URI.');
      const comma = source.uri.indexOf(',');
      if (comma < 0) throw new Error('Data URI GLTF inválida.');
      binaryBuffers.push(source.uri.slice(0, comma).toLowerCase().includes(';base64')
        ? base64Bytes(source.uri.slice(comma + 1))
        : new TextEncoder().encode(decodeURIComponent(source.uri.slice(comma + 1))));
    }
  }
  if (!json || !json.bufferViews || !json.accessors) throw new Error('GLTF/GLB sem uma cena válida.');
  const document = json;
  const readAccessor = (accessorIndex: number): number[] => {
    const accessor = document.accessors![accessorIndex];
    if (!accessor) throw new Error('Accessor GLTF inválido.');
    const viewDef = accessor.bufferView === undefined ? undefined : document.bufferViews![accessor.bufferView];
    if (!viewDef) throw new Error('Accessor GLTF sem bufferView não suportado.');
    const bytes = binaryBuffers[viewDef.buffer];
    if (!bytes) throw new Error('Buffer GLTF ausente.');
    const componentSize = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[accessor.componentType as 5120];
    if (!componentSize) throw new Error(`Component type GLTF não suportado: ${accessor.componentType}.`);
    const itemSize = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 }[accessor.type];
    if (!itemSize) throw new Error(`Tipo de accessor GLTF não suportado: ${accessor.type}.`);
    const stride = viewDef.byteStride ?? componentSize * itemSize;
    const start = (viewDef.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    const result: number[] = [];
    const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = 0; i < accessor.count; i += 1) {
      for (let component = 0; component < itemSize; component += 1) {
        const at = start + i * stride + component * componentSize;
        let value: number;
        if (accessor.componentType === 5120) value = dataView.getInt8(at);
        else if (accessor.componentType === 5121) value = dataView.getUint8(at);
        else if (accessor.componentType === 5122) value = dataView.getInt16(at, true);
        else if (accessor.componentType === 5123) value = dataView.getUint16(at, true);
        else if (accessor.componentType === 5125) value = dataView.getUint32(at, true);
        else value = dataView.getFloat32(at, true);
        if (accessor.normalized && accessor.componentType !== 5126) {
          const max = accessor.componentType === 5120 ? 127 : accessor.componentType === 5122 ? 32767 : accessor.componentType === 5121 ? 255 : 65535;
          value = Math.max(-1, value / max);
        }
        result.push(value);
      }
    }
    return result;
  };

  const positions: number[] = [];
  const triangles: number[][] = [];
  const appendPrimitive = (primitive: NonNullable<NonNullable<GltfJson['meshes']>[number]['primitives']>[number], matrix: Matrix) => {
    if (primitive.attributes.POSITION === undefined) return;
    const source = readAccessor(primitive.attributes.POSITION);
    const base = positions.length / 3;
    for (let i = 0; i < source.length; i += 3) positions.push(...transformPoint(matrix, source[i], source[i + 1], source[i + 2]));
    const sourceIndices = primitive.indices === undefined
      ? Array.from({ length: source.length / 3 }, (_, index) => index)
      : readAccessor(primitive.indices).map(Math.round);
    const mode = primitive.mode ?? 4;
    if (mode === 4) {
      for (let i = 0; i + 2 < sourceIndices.length; i += 3) triangles.push([base + sourceIndices[i], base + sourceIndices[i + 1], base + sourceIndices[i + 2]]);
    } else if (mode === 5) {
      for (let i = 0; i + 2 < sourceIndices.length; i += 1) triangles.push(i % 2 ? [base + sourceIndices[i + 1], base + sourceIndices[i], base + sourceIndices[i + 2]] : [base + sourceIndices[i], base + sourceIndices[i + 1], base + sourceIndices[i + 2]]);
    } else if (mode === 6) {
      for (let i = 1; i + 1 < sourceIndices.length; i += 1) triangles.push([base + sourceIndices[0], base + sourceIndices[i], base + sourceIndices[i + 1]]);
    }
  };
  const meshes = document.meshes ?? [];
  const nodes = document.nodes ?? [];
  const appendNode = (nodeIndex: number, parent: Matrix) => {
    const node = nodes[nodeIndex];
    if (!node) return;
    const matrix = multiplyMatrices(parent, nodeMatrix(node));
    if (node.mesh !== undefined) for (const primitive of meshes[node.mesh]?.primitives ?? []) appendPrimitive(primitive, matrix);
    for (const child of node.children ?? []) appendNode(child, matrix);
  };
  const roots = document.scenes?.[document.scene ?? 0]?.nodes;
  if (roots?.length) for (const node of roots) appendNode(node, identityMatrix());
  else if (nodes.length) {
    const referenced = new Set(nodes.flatMap((node) => node.children ?? []));
    nodes.forEach((node, index) => { if (!referenced.has(index)) appendNode(index, identityMatrix()); });
  } else {
    meshes.forEach((mesh) => mesh.primitives?.forEach((primitive) => appendPrimitive(primitive, identityMatrix())));
  }
  return normalizeTriangles(positions, triangles, format);
}

function objectToMesh(root: Object3D, format: 'FBX' | 'DAE'): MeshData {
  root.updateMatrixWorld(true);
  const positions: number[] = [];
  const triangles: number[][] = [];
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    const geometry = object.geometry;
    const attribute = geometry.getAttribute('position');
    if (!attribute) return;
    const base = positions.length / 3;
    const point = new Vector3();
    for (let i = 0; i < attribute.count; i += 1) {
      point.set(attribute.getX(i), attribute.getY(i), attribute.getZ(i)).applyMatrix4(object.matrixWorld);
      positions.push(point.x, point.y, point.z);
    }
    const index = geometry.getIndex();
    if (index) {
      for (let i = 0; i + 2 < index.count; i += 3) triangles.push([base + index.getX(i), base + index.getX(i + 1), base + index.getX(i + 2)]);
    } else {
      for (let i = 0; i + 2 < attribute.count; i += 3) triangles.push([base + i, base + i + 1, base + i + 2]);
    }
  });
  return normalizeTriangles(positions, triangles, format);
}

function parseColladaFallback(text: string): MeshData {
  const sources = new Map<string, { values: number[]; stride: number }>();
  for (const match of text.matchAll(/<source\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/source>/gi)) {
    const values = match[2].match(/<float_array\b[^>]*>([\s\S]*?)<\/float_array>/i)?.[1]
      ?.trim().split(/\s+/).map(Number) ?? [];
    const stride = Number(match[2].match(/<accessor\b[^>]*\bstride=["'](\d+)["']/i)?.[1] ?? 3);
    if (values.length) sources.set(match[1], { values, stride });
  }
  const vertices = new Map<string, string>();
  for (const match of text.matchAll(/<vertices\b[^>]*\bid=["']([^"']+)["'][^>]*>([\s\S]*?)<\/vertices>/gi)) {
    const source = match[2].match(/<input\b[^>]*\bsemantic=["']POSITION["'][^>]*\bsource=["']#([^"']+)["']/i)?.[1];
    if (source) vertices.set(match[1], source);
  }
  const positions: number[] = [];
  const triangles: number[][] = [];
  const appendPrimitive = (primitive: string, primitiveTag: 'triangles' | 'polylist') => {
    const inputs = Array.from(primitive.matchAll(/<input\b([^>]*)\/?>/gi)).map((match) => {
      const semantic = match[1].match(/\bsemantic=["']([^"']+)["']/i)?.[1]?.toUpperCase();
      const source = match[1].match(/\bsource=["']#([^"']+)["']/i)?.[1];
      const offset = Number(match[1].match(/\boffset=["'](\d+)["']/i)?.[1] ?? 0);
      return { semantic, source, offset };
    });
    const vertexInput = inputs.find((input) => input.semantic === 'VERTEX' || input.semantic === 'POSITION');
    if (!vertexInput?.source) return;
    const sourceId = vertexInput.semantic === 'VERTEX' ? vertices.get(vertexInput.source) : vertexInput.source;
    const source = sourceId ? sources.get(sourceId) : undefined;
    if (!source) return;
    const stride = Math.max(...inputs.map((input) => input.offset), 0) + 1;
    const values = primitive.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1].trim().split(/\s+/).map(Number) ?? [];
    const readIndex = (at: number) => values[at * stride + vertexInput.offset];
    const appendVertex = (index: number) => {
      const at = index * source.stride;
      positions.push(source.values[at] ?? 0, source.values[at + 1] ?? 0, source.values[at + 2] ?? 0);
      return positions.length / 3 - 1;
    };
    if (primitiveTag === 'triangles') {
      for (let i = 0; i + 2 < values.length / stride; i += 3) {
        triangles.push([appendVertex(readIndex(i)), appendVertex(readIndex(i + 1)), appendVertex(readIndex(i + 2))]);
      }
    } else {
      const counts = primitive.match(/<vcount\b[^>]*>([\s\S]*?)<\/vcount>/i)?.[1].trim().split(/\s+/).map(Number) ?? [];
      let cursor = 0;
      for (const count of counts) {
        const polygon: number[] = [];
        for (let i = 0; i < count; i += 1) polygon.push(appendVertex(readIndex(cursor + i)));
        for (let i = 1; i + 1 < polygon.length; i += 1) triangles.push([polygon[0], polygon[i], polygon[i + 1]]);
        cursor += count;
      }
    }
  };
  for (const match of text.matchAll(/<(triangles|polylist)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    appendPrimitive(match[2], match[1].toLowerCase() as 'triangles' | 'polylist');
  }
  return normalizeTriangles(positions, triangles, 'DAE');
}

function parseScene(buffer: ArrayBuffer, text: string, format: 'FBX' | 'DAE'): MeshData {
  if (format === 'DAE') {
    if (typeof DOMParser === 'undefined') return parseColladaFallback(text);
    return objectToMesh(new ColladaLoader().parse(text, '').scene, format);
  }
  return objectToMesh(new FBXLoader().parse(buffer, ''), format);
}

export function parseMesh(buffer: ArrayBuffer, fileName: string): MeshData {
  const bytes = new Uint8Array(buffer);
  const text = decoder.decode(bytes);
  const hinted = extensionFormat(fileName);
  let mesh: MeshData | null = null;
  try {
    mesh = parseBinaryStl(buffer) ?? parseAsciiStl(text);
    if (mesh) return mesh;
  } catch (error) {
    throw new Error(error instanceof Error ? error.message : 'Não foi possível ler o STL.');
  }
  const firstLine = text.split(/\r?\n/)[0]?.trim().toUpperCase() ?? '';
  if (hinted === 'OBJ' || /^V\s+[-\d]/i.test(text) || /\nf\s+/.test(text)) mesh = parseObj(text);
  else if (hinted === 'PLY' || firstLine === 'PLY') mesh = parsePly(text, bytes);
  else if (hinted === 'OFF' || firstLine === 'OFF' || firstLine === 'COFF') mesh = parseOff(text);
  else if (hinted === 'GLB') mesh = parseGltf(buffer, 'GLB');
  else if (hinted === 'GLTF' || firstLine.startsWith('{')) mesh = parseGltf(buffer, 'GLTF');
  else if (hinted === 'DAE') mesh = parseScene(buffer, text, 'DAE');
  else if (hinted === 'FBX') mesh = parseScene(buffer, text, 'FBX');
  else throw new Error('Formato não suportado. Use STL, OBJ, PLY, OFF, GLB, GLTF, FBX ou DAE.');

  if (!mesh || !mesh.indices.length) throw new Error('Malha vazia ou impossível de processar.');
  const stats = buildStats(mesh);
  if (!stats.finite) throw new Error('A malha contém valores inválidos.');
  return { ...mesh, bounds: calculateBounds(mesh.positions) };
}