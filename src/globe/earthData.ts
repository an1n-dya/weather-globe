/**
 * The format of public/data/earth.bin, shared by scripts/build-earth.ts, which
 * writes it, and the globe, which reads it. The file is one DEFLATE stream;
 * inflated, it holds:
 *
 *   "WGE2", header length (u32 LE), header JSON padded to 4 bytes, then one
 *   block per sampling level, coarse to fine. A block of n points holds
 *   u, low bytes    n x u8 \
 *   u, high bytes   n x u8  |  octahedral unit vectors, each stored as the
 *   v, low bytes    n x u8  |  difference from the point before it in the
 *   v, high bytes   n x u8 /   block, modulo 65,536
 *   values          n x u8   height (land, lakes) or depth (ocean), square-root coded
 *   infos           n x u8   surface kind in bits 0-1, biome in bits 2-5
 *
 * Points within a level follow a space-filling curve, so neighbors are close
 * and the differences small. Because levels come in order, a prefix of the
 * file is a complete, coarser globe: the first `tiers.low` points, which
 * arrive in the first fifth of the download, make the light globe.
 */

export const EARTH_MAGIC = "WGE2";

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

/** What the build writes for each point, in file order. */
export interface EncodedPoints {
  /** Octahedral u and v, two numbers per point. */
  octahedral: Uint16Array;
  values: Uint8Array;
  infos: Uint8Array;
}

/** Lays out an earth file, before compression. */
export function encodeEarth(header: EarthHeader, points: EncodedPoints): Uint8Array<ArrayBuffer> {
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerLength = Math.ceil(headerBytes.length / 4) * 4;
  const body = 8 + headerLength;
  const file = new Uint8Array(body + header.count * 6);
  file.set(new TextEncoder().encode(EARTH_MAGIC), 0);
  new DataView(file.buffer).setUint32(4, headerLength, true);
  file.set(headerBytes, 8);
  file.fill(0x20, 8 + headerBytes.length, body);
  let offset = body;
  let start = 0;
  for (const end of header.levels) {
    const n = end - start;
    let previousU = 0;
    let previousV = 0;
    for (let k = 0; k < n; k++) {
      const u = points.octahedral[(start + k) * 2]!;
      const v = points.octahedral[(start + k) * 2 + 1]!;
      const du = (u - previousU) & 0xffff;
      const dv = (v - previousV) & 0xffff;
      previousU = u;
      previousV = v;
      file[offset + k] = du & 0xff;
      file[offset + n + k] = du >> 8;
      file[offset + 2 * n + k] = dv & 0xff;
      file[offset + 3 * n + k] = dv >> 8;
    }
    file.set(points.values.subarray(start, end), offset + 4 * n);
    file.set(points.infos.subarray(start, end), offset + 5 * n);
    offset += 6 * n;
    start = end;
  }
  return file;
}

function checkHeader(header: EarthHeader): void {
  const { count, levels, tiers } = header;
  const ascending = levels.every((end, i) => end > (levels[i - 1] ?? 0));
  const tierEnds = Object.values(tiers).every((end) => levels.includes(end));
  if (!Number.isInteger(count) || count < 4 || !ascending || levels.at(-1) !== count || !tierEnds) {
    throw new Error("Earth file has a damaged header");
  }
}

/**
 * Reads an inflated earth file as it arrives. Each level is decoded as soon as
 * its block is complete, so the light globe can be built before the rest of
 * the file is in.
 */
export class EarthDecoder {
  /** Allocated once the header is in. */
  points: EarthPoints | null = null;
  /** How many points, from the start, are decoded and ready to use. */
  decoded = 0;
  private buffer = new Uint8Array(64 * 1024);
  private length = 0;
  /** Where the next level's block starts in the buffer. */
  private offset = 0;
  private level = 0;

  push(chunk: Uint8Array): void {
    if (this.length + chunk.length > this.buffer.length) {
      const grown = new Uint8Array(Math.max(this.buffer.length * 2, this.length + chunk.length));
      grown.set(this.buffer.subarray(0, this.length));
      this.buffer = grown;
    }
    this.buffer.set(chunk, this.length);
    this.length += chunk.length;
    if (!this.points) this.readHeader();
    if (this.points) this.readLevels(this.points);
  }

  /** Throws unless the whole file has arrived. */
  finish(): EarthPoints {
    if (!this.points || this.decoded < this.points.header.count) {
      throw new Error("Earth file is truncated");
    }
    return this.points;
  }

  private readHeader(): void {
    if (this.length < 8) return;
    if (new TextDecoder().decode(this.buffer.subarray(0, 4)) !== EARTH_MAGIC) {
      throw new Error("Not an earth file");
    }
    const headerLength = new DataView(this.buffer.buffer).getUint32(4, true);
    if (this.length < 8 + headerLength) return;
    const header = JSON.parse(
      new TextDecoder().decode(this.buffer.subarray(8, 8 + headerLength)),
    ) as EarthHeader;
    checkHeader(header);
    const { count } = header;
    // The whole file's size is known now, so the buffer grows only once more.
    const total = 8 + headerLength + count * 6;
    if (this.buffer.length < total) {
      const sized = new Uint8Array(total);
      sized.set(this.buffer.subarray(0, this.length));
      this.buffer = sized;
    }
    this.offset = 8 + headerLength;
    this.points = {
      header,
      positions: new Float64Array(count * 3),
      values: new Uint8Array(count),
      kinds: new Uint8Array(count),
      biomes: new Uint8Array(count),
    };
  }

  private readLevels(points: EarthPoints): void {
    const { levels } = points.header;
    const bytes = this.buffer;
    while (this.level < levels.length) {
      const start = this.decoded;
      const n = levels[this.level]! - start;
      const base = this.offset;
      if (this.length < base + 6 * n) return;
      let u = 0;
      let v = 0;
      for (let k = 0; k < n; k++) {
        u = (u + (bytes[base + k]! | (bytes[base + n + k]! << 8))) & 0xffff;
        v = (v + (bytes[base + 2 * n + k]! | (bytes[base + 3 * n + k]! << 8))) & 0xffff;
        const [x, y, z] = decodeOctahedral(u, v);
        const i = start + k;
        points.positions[i * 3] = x;
        points.positions[i * 3 + 1] = y;
        points.positions[i * 3 + 2] = z;
        points.values[i] = bytes[base + 4 * n + k]!;
        const info = bytes[base + 5 * n + k]!;
        points.kinds[i] = info & 3;
        points.biomes[i] = info >> 2;
      }
      this.offset = base + 6 * n;
      this.decoded = start + n;
      this.level++;
    }
  }
}

/** Reads a whole inflated earth file. Throws if it is not one, or is cut short. */
export function decodeEarth(file: Uint8Array): EarthPoints {
  const decoder = new EarthDecoder();
  decoder.push(file);
  return decoder.finish();
}
