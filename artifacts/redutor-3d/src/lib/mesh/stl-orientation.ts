export type StlOrientation = 'auto' | 'original' | 'x' | 'y' | 'z';

/** Rigid quarter-turn: no scaling, welding, simplification, or loss of precision. */
export function orientStlForPrint(source: ArrayBuffer, orientation: StlOrientation): ArrayBuffer {
  if (orientation === 'original' || orientation === 'z') return source;
  const input = new DataView(source);
  if (source.byteLength < 84) throw new Error('STL binário inválido.');
  const faces = input.getUint32(80, true);
  if (source.byteLength !== 84 + faces * 50) throw new Error('STL binário inválido.');
  let axis: StlOrientation = orientation;
  if (axis === 'auto') {
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let f = 0; f < faces; f++) for (let v = 0; v < 3; v++) for (let c = 0; c < 3; c++) {
      const value = input.getFloat32(84 + f * 50 + 12 + v * 12 + c * 4, true);
      min[c] = Math.min(min[c], value); max[c] = Math.max(max[c], value);
    }
    const sizes = max.map((v, i) => v - min[i]);
    const largest = sizes.indexOf(Math.max(...sizes));
    axis = (['x', 'y', 'z'] as const)[largest];
  }
  if (axis === 'z') return source;
  const result = source.slice(0), out = new DataView(result);
  for (let f = 0; f < faces; f++) for (let vector = 0; vector < 4; vector++) {
    const offset = 84 + f * 50 + vector * 12;
    const x = input.getFloat32(offset, true), y = input.getFloat32(offset + 4, true), z = input.getFloat32(offset + 8, true);
    // Proper rotations (determinant +1), including stored face normals.
    const rotated = axis === 'x' ? [-z, y, x] : [x, -z, y];
    for (let c = 0; c < 3; c++) out.setFloat32(offset + c * 4, rotated[c], true);
  }
  return result;
}

