import Delaunator from "delaunator";
import { BIOME, decodeDepth, decodeHeight, type EarthPoints, KIND } from "./earthData";

export interface EarthArrays {
  /** Flat-shaded, non-indexed triangles: three corners per face. */
  positions: Float32Array<ArrayBuffer>;
  /** RGBA per corner. Alpha is how glossy the face is: water shines, land doesn't. */
  colors: Uint8Array<ArrayBuffer>;
}

type Rgb = readonly [number, number, number];

/** Sea level is radius 1. Land sits a step above it, so continents read as raised. */
export const LAND_BASE = 0.0026;
const ICE_SHELF_BASE = 0.0018;
const LAKE_BASE = 0.0012;
/** Height of the tallest ranges, as a fraction of the radius; about 12 times true scale. */
const RELIEF = 0.0105;

const PALETTE: Readonly<Record<number, Rgb>> = {
  [BIOME.ice]: [0.9, 0.95, 0.99],
  [BIOME.snow]: [0.95, 0.97, 1.0],
  [BIOME.tundra]: [0.6, 0.64, 0.49],
  [BIOME.borealForest]: [0.2, 0.5, 0.36],
  [BIOME.temperateForest]: [0.33, 0.63, 0.29],
  [BIOME.tropicalForest]: [0.13, 0.56, 0.25],
  [BIOME.grassland]: [0.6, 0.75, 0.32],
  [BIOME.savanna]: [0.78, 0.73, 0.35],
  [BIOME.steppe]: [0.8, 0.69, 0.42],
  [BIOME.desert]: [0.96, 0.8, 0.47],
  [BIOME.redDesert]: [0.92, 0.62, 0.36],
  [BIOME.highland]: [0.62, 0.54, 0.43],
  [BIOME.none]: [0.45, 0.65, 0.35],
};

const SEA_ICE: Rgb = [0.76, 0.86, 0.93];
const LAKE_ICE: Rgb = [0.8, 0.88, 0.94];
const LAKE: Rgb = [0.2, 0.62, 0.82];
const COAST_WATER: Rgb = [0.27, 0.76, 0.85];
/** Depth in meters, and the sea's color there. */
const DEPTH_STOPS: ReadonlyArray<readonly [number, Rgb]> = [
  [0, [0.28, 0.8, 0.86]],
  [150, [0.21, 0.69, 0.85]],
  [800, [0.14, 0.53, 0.82]],
  [2500, [0.1, 0.43, 0.77]],
  [4500, [0.07, 0.33, 0.68]],
  [7000, [0.05, 0.22, 0.54]],
];

function depthColor(depth: number): Rgb {
  for (let i = 1; i < DEPTH_STOPS.length; i++) {
    const [d1, c1] = DEPTH_STOPS[i]!;
    if (depth <= d1) {
      const [d0, c0] = DEPTH_STOPS[i - 1]!;
      const t = (depth - d0) / (d1 - d0);
      return [
        c0[0] + (c1[0] - c0[0]) * t,
        c0[1] + (c1[1] - c0[1]) * t,
        c0[2] + (c1[2] - c0[2]) * t,
      ];
    }
  }
  return DEPTH_STOPS[DEPTH_STOPS.length - 1]![1];
}

/** Snow lies lower toward the poles. In meters, for the highest corner of a face. */
function snowline(lat: number): number {
  return 4300 - Math.max(0, Math.abs(lat) - 20) * 70;
}

/**
 * Where a date falls in the year, in months from mid-January: each month's
 * snow and ice describe its middle, and dates in between blend the two.
 */
export function seasonPosition(date: Date): number {
  const year = date.getUTCFullYear();
  const start = Date.UTC(year, 0, 1);
  const fraction = (date.getTime() - start) / (Date.UTC(year + 1, 0, 1) - start);
  return (fraction * 12 - 0.5 + 12) % 12;
}

/** How much a point's snow or ice is in at a season position, from 0 to 1. */
function seasonal(mask: number, position: number): number {
  const month = Math.floor(position);
  const weight = position - month;
  const now = (mask >> month) & 1;
  const next = (mask >> ((month + 1) % 12)) & 1;
  return now * (1 - weight) + next * weight;
}

/** Snow mostly hides open ground; under trees the canopy still shows through. */
const SNOW_COVER: Readonly<Record<number, number>> = {
  [BIOME.borealForest]: 0.62,
  [BIOME.temperateForest]: 0.7,
  [BIOME.tropicalForest]: 0.7,
};

/** Faces wider than this (in radians, about 130 km) are open water, not a sunlit shallow. */
const SHALLOW_MAX_EDGE = 0.02;

/** A stable pseudo-random number in [0, 1) for a point, so each face keeps its own shade. */
function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** How far above sea level a corner sits. */
function radiusOf(kind: number, value: number): number {
  switch (kind) {
    case KIND.land:
      return 1 + LAND_BASE + RELIEF * (decodeHeight(value) / 7000) ** 0.8;
    case KIND.lake:
      return 1 + LAKE_BASE + RELIEF * (decodeHeight(value) / 7000) ** 0.8;
    case KIND.iceShelf:
      return 1 + ICE_SHELF_BASE;
    default:
      return 1;
  }
}

/**
 * Delaunay triangulation of points on the unit sphere. Projects stereographically
 * from the first point (chosen to be in empty ocean), triangulates the plane,
 * and closes the hole with a fan from that point. Every face winds outward.
 */
export function triangulateSphere(points: Float64Array, count: number): Uint32Array {
  const px = points[0]!;
  const py = points[1]!;
  const pz = points[2]!;
  // Two axes at right angles to the projection point.
  const helper = Math.abs(py) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  let ax = helper[1]! * pz - helper[2]! * py;
  let ay = helper[2]! * px - helper[0]! * pz;
  let az = helper[0]! * py - helper[1]! * px;
  const al = Math.hypot(ax, ay, az);
  ax /= al;
  ay /= al;
  az /= al;
  const bx = py * az - pz * ay;
  const by = pz * ax - px * az;
  const bz = px * ay - py * ax;

  const coords = new Float64Array((count - 1) * 2);
  for (let i = 1; i < count; i++) {
    const x = points[i * 3]!;
    const y = points[i * 3 + 1]!;
    const z = points[i * 3 + 2]!;
    const k = 1 / (1 - (x * px + y * py + z * pz));
    coords[(i - 1) * 2] = (x * ax + y * ay + z * az) * k;
    coords[(i - 1) * 2 + 1] = (x * bx + y * by + z * bz) * k;
  }
  const { triangles, hull } = new Delaunator(coords);
  const faces = new Uint32Array(triangles.length + hull.length * 3);
  for (let i = 0; i < triangles.length; i++) faces[i] = triangles[i]! + 1;
  let cursor = triangles.length;
  for (let i = 0; i < hull.length; i++) {
    faces[cursor++] = 0;
    faces[cursor++] = hull[(i + 1) % hull.length]! + 1;
    faces[cursor++] = hull[i]! + 1;
  }

  // Wind each face outward, whatever convention the plane used.
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f]! * 3;
    const b = faces[f + 1]! * 3;
    const c = faces[f + 2]! * 3;
    const ux = points[b]! - points[a]!;
    const uy = points[b + 1]! - points[a + 1]!;
    const uz = points[b + 2]! - points[a + 2]!;
    const vx = points[c]! - points[a]!;
    const vy = points[c + 1]! - points[a + 1]!;
    const vz = points[c + 2]! - points[a + 2]!;
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const outward =
      nx * (points[a]! + points[b]! + points[c]!) +
      ny * (points[a + 1]! + points[b + 1]! + points[c + 1]!) +
      nz * (points[a + 2]! + points[b + 2]! + points[c + 2]!);
    if (outward < 0) {
      const t = faces[f + 1]!;
      faces[f + 1] = faces[f + 2]!;
      faces[f + 2] = t;
    }
  }
  return faces;
}

function edgeBetween(points: Float64Array, a: number, b: number): number {
  const dx = points[a * 3]! - points[b * 3]!;
  const dy = points[a * 3 + 1]! - points[b * 3 + 1]!;
  const dz = points[a * 3 + 2]! - points[b * 3 + 2]!;
  return Math.hypot(dx, dy, dz);
}

function longestEdge(points: Float64Array, corner: number[]): number {
  return Math.max(
    edgeBetween(points, corner[0]!, corner[1]!),
    edgeBetween(points, corner[1]!, corner[2]!),
    edgeBetween(points, corner[2]!, corner[0]!),
  );
}

/** The edge between a face's two land corners, given its one water corner. */
function shortestLandEdge(points: Float64Array, corner: number[], water: number): number {
  const [a, b] = corner.filter((v) => v !== water);
  return a === undefined || b === undefined ? 0 : edgeBetween(points, a, b);
}

/** Builds the globe from the first `count` points, with the snow and ice of `date`'s season. */
export function buildEarthArrays(
  data: EarthPoints,
  count: number,
  date: Date = new Date(),
): EarthArrays {
  const n = Math.min(count, data.header.count);
  const { positions: points, values, kinds, biomes, seasons } = data;
  const season = seasonPosition(date);
  const faces = triangulateSphere(points, n);
  const faceTotal = faces.length / 3;

  const radii = new Float32Array(n);
  for (let v = 0; v < n; v++) radii[v] = radiusOf(kinds[v]!, values[v]!);

  const positions = new Float32Array(faceTotal * 9);
  const colors = new Uint8Array(faceTotal * 12);
  const corner = [0, 0, 0];

  for (let f = 0; f < faceTotal; f++) {
    corner[0] = faces[f * 3]!;
    corner[1] = faces[f * 3 + 1]!;
    corner[2] = faces[f * 3 + 2]!;

    let solid = 0;
    let lakes = 0;
    let oceans = 0;
    let heightSum = 0;
    let heightMax = 0;
    let heightMin = Number.POSITIVE_INFINITY;
    let depthSum = 0;
    let snowSum = 0;
    let lakeIceSum = 0;
    let seaIceSum = 0;
    let waterCorner = -1;
    let cx = 0;
    let cy = 0;
    let cz = 0;
    for (let c = 0; c < 3; c++) {
      const v = corner[c]!;
      const kind = kinds[v]!;
      const cover = seasonal(seasons[v]!, season);
      if (kind === KIND.land || kind === KIND.iceShelf) {
        solid++;
        snowSum += cover;
        const height = decodeHeight(values[v]!);
        heightSum += height;
        heightMax = Math.max(heightMax, height);
        heightMin = Math.min(heightMin, height);
      } else if (kind === KIND.lake) {
        lakes++;
        lakeIceSum += cover;
        waterCorner = v;
      } else {
        oceans++;
        seaIceSum += cover;
        depthSum += decodeDepth(values[v]!);
        waterCorner = v;
      }
      const r = radii[v]!;
      const x = points[v * 3]!;
      const y = points[v * 3 + 1]!;
      const z = points[v * 3 + 2]!;
      positions[f * 9 + c * 3] = x * r;
      positions[f * 9 + c * 3 + 1] = y * r;
      positions[f * 9 + c * 3 + 2] = z * r;
      cx += x;
      cy += y;
      cz += z;
    }

    // Each face keeps its own slightly different shade, so the facets catch the eye.
    const shade = hash3(cx * 31.7, cy * 31.7, cz * 31.7);
    const longest = longestEdge(points, corner);
    // Two land corners usually make land, unless the water corner is far out to
    // sea: then the face is mostly sea, reaching a small island's shore.
    let land = solid >= 2;
    if (solid === 2 && waterCorner >= 0) {
      const landEdge = shortestLandEdge(points, corner, waterCorner);
      if (longest > Math.max(0.012, landEdge * 3)) land = false;
    }
    let rgb: Rgb;
    let gloss = 0;
    let jitter: number;
    if (land) {
      // The most common biome among the land corners; ties go to the first.
      let biome: number = BIOME.none;
      let best = 0;
      for (let c = 0; c < 3; c++) {
        const v = corner[c]!;
        if (kinds[v] !== KIND.land && kinds[v] !== KIND.iceShelf) continue;
        let votes = 0;
        for (let d = 0; d < 3; d++) if (biomes[corner[d]!] === biomes[v]) votes++;
        if (votes > best) {
          best = votes;
          biome = biomes[v]!;
        }
      }
      rgb = PALETTE[biome] ?? PALETTE[BIOME.none]!;
      const height = heightSum / solid;
      // Bare, higher ground turns browner before the snowline.
      if (height > 1800 && biome !== BIOME.ice && biome !== BIOME.snow) {
        const t = Math.min(1, (height - 1800) / 2800) * 0.45;
        const rock = PALETTE[BIOME.highland]!;
        rgb = [
          rgb[0] + (rock[0] - rgb[0]) * t,
          rgb[1] + (rock[1] - rgb[1]) * t,
          rgb[2] + (rock[2] - rgb[2]) * t,
        ];
      }
      // Snow caps on peaks: high, and steep enough not to be a plateau. Dry high
      // ground such as Tibet stays bare except for its tallest peaks.
      const length = Math.hypot(cx, cy, cz) || 1;
      const dry =
        biome === BIOME.highland ||
        biome === BIOME.desert ||
        biome === BIOME.redDesert ||
        biome === BIOME.steppe;
      const line = snowline(Math.asin(cy / length) * (180 / Math.PI)) + (dry ? 2000 : 0);
      const steep = heightMax - heightMin > 500 || heightMax > line + 1400;
      // Below the highest peaks, the caps come and go with the season's snow.
      const capped =
        steep && heightMax > line && (heightMax > line + 1500 || snowSum / solid > 0.25);
      if (biome === BIOME.snow || capped) rgb = PALETTE[BIOME.snow]!;
      if (rgb === PALETTE[BIOME.snow] || biome === BIOME.ice) {
        gloss = 70;
      } else if (snowSum / solid > 0.3 + 0.4 * shade) {
        // The season's snow comes and goes a few faces at a time, not along a hard line.
        const cover = SNOW_COVER[biome] ?? 0.9;
        const snow = PALETTE[BIOME.snow]!;
        rgb = [
          rgb[0] + (snow[0] - rgb[0]) * cover,
          rgb[1] + (snow[1] - rgb[1]) * cover,
          rgb[2] + (snow[2] - rgb[2]) * cover,
        ];
        gloss = 60;
      }
      jitter = 0.9 + shade * 0.17;
    } else if (lakes > oceans) {
      if (lakeIceSum / lakes > 0.3 + 0.4 * shade) {
        rgb = LAKE_ICE;
        gloss = 90;
      } else {
        rgb = solid > 0 && longest < SHALLOW_MAX_EDGE ? COAST_WATER : LAKE;
        gloss = 220;
      }
      jitter = 0.95 + shade * 0.08;
    } else {
      if (oceans > 0 && seaIceSum / oceans > 0.3 + 0.4 * shade) {
        rgb = SEA_ICE;
        gloss = 90;
      } else {
        // Small faces touching the shore are shallow and bright; the rest follows the depth.
        rgb =
          solid > 0 && longest < SHALLOW_MAX_EDGE
            ? COAST_WATER
            : depthColor(oceans ? depthSum / oceans : 0);
        gloss = 255;
      }
      jitter = 0.94 + shade * 0.1;
    }

    const red = Math.min(255, Math.round(rgb[0] * jitter * 255));
    const green = Math.min(255, Math.round(rgb[1] * jitter * 255));
    const blue = Math.min(255, Math.round(rgb[2] * jitter * 255));
    for (let c = 0; c < 3; c++) {
      colors[f * 12 + c * 4] = red;
      colors[f * 12 + c * 4 + 1] = green;
      colors[f * 12 + c * 4 + 2] = blue;
      colors[f * 12 + c * 4 + 3] = gloss;
    }
  }

  return { positions, colors };
}
