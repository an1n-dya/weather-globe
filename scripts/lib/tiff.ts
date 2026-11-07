/** An 8-bit, one-channel raster, and where it sits in its map projection. */
export interface Tiff8 {
  width: number;
  height: number;
  data: Uint8Array;
  /** Projected coordinates of the top-left corner, and the size of a pixel. */
  originX: number;
  originY: number;
  pixelWidth: number;
  pixelHeight: number;
}

const TYPE_SIZES: Readonly<Record<number, number>> = { 1: 1, 3: 2, 4: 4, 12: 8 };

/**
 * Reads an uncompressed, 8-bit, one-channel GeoTIFF, such as the NSIDC sea ice
 * grids. Anything else is refused rather than misread.
 */
export function readTiff8(file: Uint8Array): Tiff8 {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const order = String.fromCharCode(file[0] ?? 0, file[1] ?? 0);
  if (order !== "II" && order !== "MM") throw new Error("Not a TIFF file");
  const little = order === "II";
  if (view.getUint16(2, little) !== 42) throw new Error("Not a classic TIFF file");
  const ifd = view.getUint32(4, little);
  const tags = new Map<number, number[]>();
  for (let i = 0; i < view.getUint16(ifd, little); i++) {
    const at = ifd + 2 + i * 12;
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const count = view.getUint32(at + 4, little);
    const size = TYPE_SIZES[type];
    if (!size) continue;
    const offset = size * count <= 4 ? at + 8 : view.getUint32(at + 8, little);
    const values: number[] = [];
    for (let k = 0; k < count; k++) {
      const p = offset + k * size;
      values.push(
        size === 1
          ? view.getUint8(p)
          : size === 2
            ? view.getUint16(p, little)
            : size === 4
              ? view.getUint32(p, little)
              : view.getFloat64(p, little),
      );
    }
    tags.set(tag, values);
  }
  const first = (tag: number) => tags.get(tag)?.[0];
  const width = first(256);
  const height = first(257);
  if (!width || !height) throw new Error("TIFF has no size");
  if ((first(259) ?? 1) !== 1) throw new Error("Only uncompressed TIFFs can be read");
  if ((first(258) ?? 8) !== 8 || (first(277) ?? 1) !== 1) {
    throw new Error("Only 8-bit, one-channel TIFFs can be read");
  }
  const scale = tags.get(33550);
  const tiepoint = tags.get(33922);
  if (!scale || !tiepoint || tiepoint[0] !== 0 || tiepoint[1] !== 0) {
    throw new Error("TIFF has no georeference");
  }
  const offsets = tags.get(273) ?? [];
  const counts = tags.get(279) ?? [];
  const data = new Uint8Array(width * height);
  let filled = 0;
  offsets.forEach((offset, i) => {
    const length = Math.min(counts[i] ?? 0, data.length - filled);
    data.set(file.subarray(offset, offset + length), filled);
    filled += length;
  });
  if (filled < data.length) throw new Error("TIFF is truncated");
  return {
    width,
    height,
    data,
    originX: tiepoint[3]!,
    originY: tiepoint[4]!,
    pixelWidth: scale[0]!,
    pixelHeight: scale[1]!,
  };
}
