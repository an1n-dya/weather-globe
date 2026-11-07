/**
 * The format of public/data/earth.bin, shared by scripts/build-earth.ts, which
 * writes it, and the globe, which reads it. After inflating:
 *
 *   "WGE1", header length (u32 LE), header JSON padded to 4 bytes, then
 *   positions  count x 2 x u16  octahedral unit vectors
 *   values     count x u8       height (land, lakes) or depth (ocean), square-root coded
 *   infos      count x u8       surface kind in bits 0-1, biome in bits 2-5
 *
 * Points are ordered coarse to fine: the first `tiers.low` points make the
 * light globe, and so on.
 */

export const EARTH_MAGIC = "WGE1";

export type DetailTier = "low" | "medium" | "high";

export interface EarthHeader {
  count: number;
  /** Points at the end of each sampling level, coarse to fine. */
  levels: number[];
  tiers: Record<DetailTier, number>;
}

/** Surface kinds match SURFACE in src/geo/regions.ts. */
export const KIND = { ocean: 0, land: 1, lake: 2, iceShelf: 3 } as const;
export type Kind = (typeof KIND)[keyof typeof KIND];

export const BIOME = {
  none: 0,
  ice: 1,
  snow: 2,
  tundra: 3,
  borealForest: 4,
  temperateForest: 5,
  tropicalForest: 6,
  grassland: 7,
  savanna: 8,
  steppe: 9,
  desert: 10,
  redDesert: 11,
  highland: 12,
} as const;
export type Biome = (typeof BIOME)[keyof typeof BIOME];

const MAX_HEIGHT_M = 7000;
const MAX_DEPTH_M = 11000;

/** Square-root coding keeps detail in the lowlands and shallows, where most of the planet is. */
export function encodeHeight(meters: number): number {
  return Math.round(255 * Math.sqrt(Math.min(MAX_HEIGHT_M, Math.max(0, meters)) / MAX_HEIGHT_M));
}

export function decodeHeight(code: number): number {
  return MAX_HEIGHT_M * (code / 255) ** 2;
}

export function encodeDepth(meters: number): number {
  return Math.round(255 * Math.sqrt(Math.min(MAX_DEPTH_M, Math.max(0, meters)) / MAX_DEPTH_M));
}

export function decodeDepth(code: number): number {
  return MAX_DEPTH_M * (code / 255) ** 2;
}

export function packInfo(kind: Kind, biome: number): number {
  return (kind & 3) | ((biome & 15) << 2);
}

const signNotZero = (v: number) => (v >= 0 ? 1 : -1);

/**
 * Maps a unit vector onto an octahedron unfolded into a square, two 16-bit
 * numbers: about 0.3 km accuracy anywhere on Earth, with no seam or pole.
 */
export function encodeOctahedral(x: number, y: number, z: number): [number, number] {
  const sum = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / sum;
  let v = y / sum;
  if (z < 0) {
    const fu = (1 - Math.abs(v)) * signNotZero(u);
    const fv = (1 - Math.abs(u)) * signNotZero(v);
    u = fu;
    v = fv;
  }
  return [Math.round((u * 0.5 + 0.5) * 65535), Math.round((v * 0.5 + 0.5) * 65535)];
}

export function decodeOctahedral(qu: number, qv: number): [number, number, number] {
  const u = (qu / 65535) * 2 - 1;
  const v = (qv / 65535) * 2 - 1;
  let x = u;
  let y = v;
  const z = 1 - Math.abs(u) - Math.abs(v);
  if (z < 0) {
    x = (1 - Math.abs(v)) * signNotZero(u);
    y = (1 - Math.abs(u)) * signNotZero(v);
  }
  const length = Math.hypot(x, y, z) || 1;
  return [x / length, y / length, z / length];
}

export interface EarthPoints {
  header: EarthHeader;
  /** Unit vectors, three numbers per point. */
  positions: Float64Array;
  values: Uint8Array;
  kinds: Uint8Array;
  biomes: Uint8Array;
}

/** Reads an inflated earth.bin. Throws if the file is not one. */
export function decodeEarth(file: Uint8Array): EarthPoints {
  if (new TextDecoder().decode(file.subarray(0, 4)) !== EARTH_MAGIC) {
    throw new Error("Not an earth file");
  }
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const headerLength = view.getUint32(4, true);
  const header = JSON.parse(
    new TextDecoder().decode(file.subarray(8, 8 + headerLength)),
  ) as EarthHeader;
  const { count } = header;
  const body = 8 + headerLength;
  if (!Number.isInteger(count) || count < 4 || file.byteLength < body + count * 6) {
    throw new Error("Earth file is truncated");
  }
  const positions = new Float64Array(count * 3);
  for (let i = 0; i < count; i++) {
    const [x, y, z] = decodeOctahedral(
      view.getUint16(body + i * 4, true),
      view.getUint16(body + i * 4 + 2, true),
    );
    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;
  }
  const values = file.slice(body + count * 4, body + count * 5);
  const infos = file.subarray(body + count * 5, body + count * 6);
  const kinds = new Uint8Array(count);
  const biomes = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    kinds[i] = infos[i]! & 3;
    biomes[i] = infos[i]! >> 2;
  }
  return { header, positions, values, kinds, biomes };
}
