/**
 * Builds public/data/earth.bin: the points the globe is made of.
 *
 * Points are dense along coastlines and sparse in open ocean and deep
 * interiors, so the globe keeps big crystalline facets where little happens
 * and spends its triangles where shapes need them. They come in coarse to fine
 * levels: any prefix of the list is itself an evenly spread, coarser globe,
 * which is how the low and medium detail tiers and the progressive load work.
 *
 * Each point records what it is (ocean, land, lake or ice shelf), its height or
 * depth, and its biome. The app triangulates the points itself (a spherical
 * Delaunay triangulation, in a worker), and each triangle takes its look from
 * its three corners. Nothing depends on face order, so unlike the old
 * per-face land mask there is nothing separate to keep in step with the mesh:
 * change the sampling here, rebuild, and the app follows.
 *
 * Sources, downloaded once into node_modules/.cache:
 *  - Natural Earth land, lakes, ice shelves and glaciers (public domain)
 *  - ETOPO5 elevation and bathymetry, NOAA NCEI (public domain)
 *  - NASA Blue Marble Next Generation, February and August (public domain), for vegetation
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { geoArea } from "d3-geo";
import { deflateSync } from "fflate";
import type { Feature, FeatureCollection, Geometry, Position } from "geojson";
import { around, distance as kmBetween } from "geokdbush";
import jpeg from "jpeg-js";
import KDBush from "kdbush";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { DEG, latLonToVec3, vec3ToLatLon } from "../src/geo/coords";
import { SURFACE } from "../src/geo/regions";
import {
  BIOME,
  type Biome,
  EARTH_MAGIC,
  type EarthHeader,
  encodeDepth,
  encodeHeight,
  encodeOctahedral,
  packInfo,
} from "../src/globe/earthData";
import { cachedDownload, cachedJson, naturalEarth, root } from "./lib/download";
import { rasterize, rewind } from "./lib/raster";

const EARTH_RADIUS_KM = 6371;

/** Final-level spacing of samples along coastlines. */
const COAST_SPACING_KM = 19;
/** How far each coastline sample's land and water points sit from the line. */
const COAST_OFFSET_KM = 5.5;
/** Interior points keep at least this far from a coastline. */
const COAST_CLEARANCE_KM = COAST_OFFSET_KM * 2.2;
/** Lakes smaller than this are left out of the coastlines. */
const MIN_LAKE_KM2 = 2500;
/** Coarse to fine. A prefix of levels is a complete, evenly spread globe. */
const LEVEL_SCALES = [4, 2.83, 2, 1.41, 1];

const SURFACE_W = 16384;
const SURFACE_H = 8192;

type Vec3 = [number, number, number];
type Props = Record<string, unknown>;
type Collection = FeatureCollection<Geometry, Props>;

// ---------------------------------------------------------------------------
// Small helpers

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};
/** Moves along the sphere from `p` in tangent direction `t` by `km`. */
const offsetAlong = (p: Vec3, t: Vec3, km: number): Vec3 => {
  const angle = km / EARTH_RADIUS_KM;
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return normalize([p[0] * c + t[0] * s, p[1] * c + t[1] * s, p[2] * c + t[2] * s]);
};
const kmToChord = (km: number) => 2 * Math.sin(km / EARTH_RADIUS_KM / 2);

// ---------------------------------------------------------------------------
// The surface: ocean, land, lake or ice shelf, on a fine grid

interface Shapes {
  land: Collection;
  lakes: Array<Feature<Geometry, Props>>;
  shelves: Array<Feature<Geometry, Props>>;
  glaciers: Array<Feature<Geometry, Props>>;
}

async function loadShapes(): Promise<Shapes> {
  const topology = JSON.parse(
    readFileSync(join(root, "node_modules/world-atlas/land-50m.json"), "utf8"),
  ) as Topology<{ land: GeometryCollection }>;
  // A GeometryCollection becomes a FeatureCollection.
  const land = feature(topology, topology.objects.land) as unknown as Collection;
  const [lakes, shelves, glaciers] = await Promise.all([
    cachedJson<Collection>(naturalEarth("ne_50m_lakes"), "ne_50m_lakes.geojson"),
    cachedJson<Collection>(
      naturalEarth("ne_50m_antarctic_ice_shelves_polys"),
      "ne_50m_antarctic_ice_shelves_polys.geojson",
    ),
    cachedJson<Collection>(
      naturalEarth("ne_50m_glaciated_areas"),
      "ne_50m_glaciated_areas.geojson",
    ),
  ]);
  return {
    land,
    lakes: lakes.features.map((f) => rewind(f)),
    shelves: shelves.features.map((f) => rewind(f)),
    glaciers: glaciers.features.map((f) => rewind(f)),
  };
}

const lakeArea = (lake: Feature<Geometry, Props>) => geoArea(lake) * EARTH_RADIUS_KM ** 2;

function rasterizeSurface(shapes: Shapes): Uint8Array {
  const surface = new Uint8Array(SURFACE_W * SURFACE_H);
  const paint = (object: Feature<Geometry, Props> | Collection, value: number) =>
    rasterize(object, SURFACE_W, SURFACE_H, (row, from, to) => {
      surface.fill(value, row * SURFACE_W + from, row * SURFACE_W + to + 1);
    });
  for (const shelf of shapes.shelves) paint(shelf, SURFACE.iceShelf);
  paint(shapes.land, SURFACE.land);
  // Lakes too small to get a shoreline would only show up as stray triangles.
  for (const lake of shapes.lakes) {
    if (lakeArea(lake) >= MIN_LAKE_KM2) paint(lake, SURFACE.lake);
  }
  return surface;
}

function maskOf(
  objects: Array<Feature<Geometry, Props>>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const object of objects) {
    rasterize(object, width, height, (row, from, to) => {
      mask.fill(1, row * width + from, row * width + to + 1);
    });
  }
  return mask;
}

function gridIndex(width: number, height: number, lat: number, lon: number): number {
  const x = Math.min(width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)));
  return y * width + x;
}

// ---------------------------------------------------------------------------
// Coastlines, sampled from the shapes' own rings

interface CoastSample {
  p: Vec3;
  /** Unit vector across the coastline, in the tangent plane. */
  across: Vec3;
  /** Which run of coastline it came from, and how many samples that run has. */
  run: number;
  runSize: number;
}

/** Coastlines with this few samples (small islands) appear whole at one level, or not at all. */
const WHOLE_RUN_SAMPLES = 14;

/** Rings to follow: land, ice shelf fronts and the larger lakes. */
function coastRings(shapes: Shapes): Position[][] {
  const rings: Position[][] = [];
  const collect = (geometry: Geometry | null) => {
    if (!geometry) return;
    if (geometry.type === "Polygon") rings.push(...geometry.coordinates);
    else if (geometry.type === "MultiPolygon")
      for (const p of geometry.coordinates) rings.push(...p);
  };
  for (const f of shapes.land.features) collect(f.geometry);
  for (const shelf of shapes.shelves) collect(shelf.geometry);
  for (const lake of shapes.lakes) {
    if (lakeArea(lake) >= MIN_LAKE_KM2) collect(lake.geometry);
  }
  return rings;
}

/**
 * Walks each ring and drops a sample every `spacing` km of straight-line
 * distance, like a pair of dividers, so tiny wiggles don't crowd it. Edges
 * along the antimeridian and the south pole are cuts in the data, not coasts.
 */
function sampleCoasts(rings: Position[][], spacingKm: number): CoastSample[] {
  const samples: CoastSample[] = [];
  let runId = 0;
  const isCut = (a: Position, b: Position) =>
    (Math.abs(a[0]!) > 179.9999 && Math.abs(b[0]!) > 179.9999) ||
    (a[1]! < -89.999 && b[1]! < -89.999);

  for (const ring of rings) {
    // Split the ring into runs of real coastline.
    const runs: Vec3[][] = [];
    let run: Vec3[] = [];
    for (let i = 0; i < ring.length - 1; i++) {
      const a = ring[i]!;
      const b = ring[i + 1]!;
      if (isCut(a, b)) {
        if (run.length > 1) runs.push(run);
        run = [];
        continue;
      }
      if (run.length === 0) run.push(latLonToVec3(a[1]!, a[0]!));
      run.push(latLonToVec3(b[1]!, b[0]!));
    }
    if (run.length > 1) runs.push(run);

    for (const line of runs) {
      let length = 0;
      for (let i = 1; i < line.length; i++) {
        length += Math.acos(Math.min(1, dot(line[i - 1]!, line[i]!))) * EARTH_RADIUS_KM;
      }
      // Small islands still get at least four samples, if they are worth any.
      if (length < 30) continue;
      const step = Math.max(9, Math.min(spacingKm, length / 4));
      const chord = kmToChord(step);
      // Densify first, so no segment is longer than a quarter step, then walk it.
      const dense: Vec3[] = [line[0]!];
      for (let i = 1; i < line.length; i++) {
        const a = line[i - 1]!;
        const b = line[i]!;
        const km = Math.acos(Math.min(1, dot(a, b))) * EARTH_RADIUS_KM;
        const parts = Math.max(1, Math.ceil(km / (step / 4)));
        for (let k = 1; k <= parts; k++) {
          const t = k / parts;
          dense.push(
            normalize([
              a[0] + (b[0] - a[0]) * t,
              a[1] + (b[1] - a[1]) * t,
              a[2] + (b[2] - a[2]) * t,
            ]),
          );
        }
      }
      const picked: Vec3[] = [dense[0]!];
      let last = dense[0]!;
      for (const q of dense) {
        if (Math.hypot(q[0] - last[0], q[1] - last[1], q[2] - last[2]) >= chord) {
          picked.push(q);
          last = q;
        }
      }
      const run = runId++;
      const runSamples: Array<Omit<CoastSample, "runSize">> = [];
      for (let i = 0; i < picked.length; i++) {
        const p = picked[i]!;
        const before = picked[Math.max(0, i - 1)]!;
        const after = picked[Math.min(picked.length - 1, i + 1)]!;
        const along = normalize([after[0] - before[0], after[1] - before[1], after[2] - before[2]]);
        if (!Number.isFinite(along[0]) || (along[0] === 0 && along[1] === 0 && along[2] === 0))
          continue;
        runSamples.push({ p, across: normalize(cross(p, along)), run });
      }
      for (const sample of runSamples) samples.push({ ...sample, runSize: runSamples.length });
    }
  }
  return samples;
}

// ---------------------------------------------------------------------------
// Rasters sampled at points: ETOPO5 heights and Blue Marble colors

const ETOPO_W = 4320;
const ETOPO_H = 2160;

class Etopo {
  private readonly values: Int16Array;
  constructor(raw: Buffer) {
    this.values = new Int16Array(ETOPO_W * ETOPO_H);
    for (let i = 0; i < this.values.length; i++) this.values[i] = raw.readInt16BE(i * 2);
  }
  /** Bilinear height in meters; negative is below sea level. Rows start at 90°N, columns at 0°E. */
  at(lat: number, lon: number): number {
    const fy = Math.min(ETOPO_H - 1.001, Math.max(0, (90 - lat) * 12));
    const fx = ((((lon % 360) + 360) % 360) * 12) % ETOPO_W;
    const y0 = Math.floor(fy);
    const x0 = Math.floor(fx);
    const x1 = (x0 + 1) % ETOPO_W;
    const ty = fy - y0;
    const tx = fx - x0;
    const v = (x: number, y: number) => this.values[y * ETOPO_W + x]!;
    const top = v(x0, y0) * (1 - tx) + v(x1, y0) * tx;
    const bottom = v(x0, y0 + 1) * (1 - tx) + v(x1, y0 + 1) * tx;
    return top * (1 - ty) + bottom * ty;
  }
}

interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

function colorAt(image: Image, lat: number, lon: number): Vec3 {
  const x = Math.min(image.width - 1, Math.floor(((lon + 180) / 360) * image.width));
  const y = Math.min(image.height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * image.height)));
  const i = (y * image.width + x) * 4;
  return [image.data[i]! / 255, image.data[i + 1]! / 255, image.data[i + 2]! / 255];
}

/** Points spread over a disk around `p`, for averaging rasters over a sample's area. */
function footprint(p: Vec3, radiusKm: number): Vec3[] {
  const up: Vec3 = Math.abs(p[1]) < 0.95 ? [0, 1, 0] : [1, 0, 0];
  const e1 = normalize(cross(up, p));
  const e2 = cross(p, e1);
  const points: Vec3[] = [p];
  for (const [ring, count] of [
    [0.45, 6],
    [0.9, 12],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + ring;
      const t = normalize([
        e1[0] * Math.cos(a) + e2[0] * Math.sin(a),
        e1[1] * Math.cos(a) + e2[1] * Math.sin(a),
        e1[2] * Math.cos(a) + e2[2] * Math.sin(a),
      ]);
      points.push(offsetAlong(p, t, radiusKm * ring));
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Biomes from vegetation color, latitude and height

interface LandLook {
  /** Average color in the greener of the two months. */
  color: Vec3;
  /** Greenness in the browner of the two months. */
  minGreen: number;
  /** Brightness in the darker (less snowy) of the two months. */
  minBrightness: number;
  glaciated: boolean;
}

function classify(lat: number, height: number, look: LandLook): Biome {
  const [r, g, b] = look.color;
  const brightness = (r + g + b) / 3;
  const green = (g - r) / (g + r + 0.001);
  const saturation = (Math.max(r, g, b) - Math.min(r, g, b)) / (Math.max(r, g, b) + 0.001);
  const absLat = Math.abs(lat);

  if (look.glaciated || lat < -60 || (look.minBrightness > 0.78 && saturation < 0.12)) {
    return BIOME.ice;
  }
  // The snowline falls from about 5,200 m in the tropics toward the poles.
  const snowline = 5200 - Math.max(0, absLat - 25) * 70;
  if (height > snowline && saturation < 0.25) return BIOME.snow;
  if (height > 3300 && green < 0.08) return BIOME.highland;
  if (absLat > 62 && green < 0.12) return BIOME.tundra;
  if (green < -0.06 && brightness > 0.33) {
    return green < -0.15 && r - b > 0.22 ? BIOME.redDesert : BIOME.desert;
  }
  if (green < -0.03) return BIOME.steppe;
  if (green < 0.085) return absLat < 25 ? BIOME.savanna : BIOME.grassland;
  // In the tropics only forest stays green through the dry season.
  if (absLat < 23.5) return look.minGreen > 0.05 ? BIOME.tropicalForest : BIOME.savanna;
  if (absLat < 52) return BIOME.temperateForest;
  return BIOME.borealForest;
}

// ---------------------------------------------------------------------------
// Variable-density Poisson sampling on the sphere

/** Grids at several cell sizes, so both 20 km and 2,000 km neighborhoods are quick to search. */
class PointHash {
  private readonly levels: Array<{ cell: number; map: Map<number, number[]> }>;
  constructor(
    private readonly points: number[],
    cellKms: number[],
  ) {
    this.levels = cellKms.map((km) => ({ cell: kmToChord(km), map: new Map() }));
  }

  private static key(i: number, j: number, k: number): number {
    return ((i + 1024) * 2048 + (j + 1024)) * 2048 + (k + 1024);
  }

  insert(index: number): void {
    const x = this.points[index * 3]!;
    const y = this.points[index * 3 + 1]!;
    const z = this.points[index * 3 + 2]!;
    for (const { cell, map } of this.levels) {
      const key = PointHash.key(Math.floor(x / cell), Math.floor(y / cell), Math.floor(z / cell));
      const list = map.get(key);
      if (list) list.push(index);
      else map.set(key, [index]);
    }
  }

  /** Whether any stored point lies within `chord` of p. */
  anyWithin(p: Vec3, chord: number): boolean {
    const level =
      this.levels.find((l) => l.cell * 2.5 >= chord) ?? this.levels[this.levels.length - 1]!;
    const { cell, map } = level;
    const span = Math.ceil(chord / cell);
    const ci = Math.floor(p[0] / cell);
    const cj = Math.floor(p[1] / cell);
    const ck = Math.floor(p[2] / cell);
    const limit = chord * chord;
    for (let i = ci - span; i <= ci + span; i++) {
      for (let j = cj - span; j <= cj + span; j++) {
        for (let k = ck - span; k <= ck + span; k++) {
          const list = map.get(PointHash.key(i, j, k));
          if (!list) continue;
          for (const index of list) {
            const dx = this.points[index * 3]! - p[0];
            const dy = this.points[index * 3 + 1]! - p[1];
            const dz = this.points[index * 3 + 2]! - p[2];
            if (dx * dx + dy * dy + dz * dz < limit) return true;
          }
        }
      }
    }
    return false;
  }
}

// ---------------------------------------------------------------------------

async function main() {
  const started = Date.now();
  const log = (message: string) =>
    console.log(`${((Date.now() - started) / 1000).toFixed(1)}s ${message}`);

  const shapes = await loadShapes();
  const surface = rasterizeSurface(shapes);
  const surfaceAt = (lat: number, lon: number) =>
    surface[gridIndex(SURFACE_W, SURFACE_H, lat, lon)]!;
  const glacierMask = maskOf(shapes.glaciers, 8192, 4096);
  log("rasterized land, lakes, ice shelves and glaciers");

  const etopo = new Etopo(
    await cachedDownload(
      "https://www.ngdc.noaa.gov/mgg/global/relief/ETOPO5/TOPO/ETOPO5/ETOPO5.DAT",
      "ETOPO5.DAT",
    ),
  );
  const bmng = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images/bmng/bmng-base";
  const months = await Promise.all(
    [
      [`${bmng}/february/world.200402.3x5400x2700.jpg`, "bmng-02.jpg"],
      [`${bmng}/august/world.200408.3x5400x2700.jpg`, "bmng-08.jpg"],
    ].map(async ([url, name]) =>
      jpeg.decode(await cachedDownload(url!, name!), { useTArray: true, maxMemoryUsageInMB: 1024 }),
    ),
  );
  log("loaded heights and imagery");

  // Roughness: how much the ground varies nearby, so mountains get more points.
  const ROUGH_W = 1440;
  const ROUGH_H = 720;
  const roughRaw = new Float32Array(ROUGH_W * ROUGH_H);
  for (let y = 0; y < ROUGH_H; y++) {
    for (let x = 0; x < ROUGH_W; x++) {
      const lat = 90 - (y + 0.5) / 4;
      const lon = -180 + (x + 0.5) / 4;
      let sum = 0;
      let sumSq = 0;
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const h = Math.max(0, etopo.at(lat + dy * 0.12, lon + dx * 0.12));
          sum += h;
          sumSq += h * h;
          n++;
        }
      }
      const mean = sum / n;
      roughRaw[y * ROUGH_W + x] = Math.sqrt(Math.max(0, sumSq / n - mean * mean)) + mean * 0.08;
    }
  }
  const rough = new Float32Array(ROUGH_W * ROUGH_H);
  for (let y = 0; y < ROUGH_H; y++) {
    for (let x = 0; x < ROUGH_W; x++) {
      let sum = 0;
      let n = 0;
      for (let dy = -2; dy <= 2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= ROUGH_H) continue;
        for (let dx = -2; dx <= 2; dx++) {
          sum += roughRaw[yy * ROUGH_W + ((x + dx + ROUGH_W) % ROUGH_W)]!;
          n++;
        }
      }
      rough[y * ROUGH_W + x] = Math.min(1, sum / n / 450);
    }
  }
  const roughAt = (lat: number, lon: number) => rough[gridIndex(ROUGH_W, ROUGH_H, lat, lon)]!;
  log("measured roughness");

  const coast = sampleCoasts(coastRings(shapes), COAST_SPACING_KM);
  const coastIndex = new KDBush(coast.length);
  const coastLatLon = coast.map(({ p }) => vec3ToLatLon(p[0], p[1], p[2]));
  for (const { lat, lon } of coastLatLon) coastIndex.add(lon, lat);
  coastIndex.finish();
  const distanceToCoast = (lat: number, lon: number): number => {
    const [nearest] = around(coastIndex, lon, lat, 1);
    if (nearest === undefined) return 20_000;
    const c = coastLatLon[nearest]!;
    return kmBetween(lon, lat, c.lon, c.lat);
  };
  log(`${coast.length} coastline samples`);

  const isSolid = (kind: number) => kind === SURFACE.land || kind === SURFACE.iceShelf;
  /** The spacing wanted around a point at the finest level, in km. */
  const spacingAt = (lat: number, lon: number, kind: number, dCoast: number): number => {
    if (isSolid(kind)) {
      const r = roughAt(lat, lon);
      const flat = Math.min(170, COAST_SPACING_KM + 0.36 * dCoast);
      return Math.max(COAST_SPACING_KM, flat * (1 - 0.55 * r));
    }
    if (kind === SURFACE.lake) return Math.min(60, COAST_SPACING_KM + 0.4 * dCoast);
    // Finer in the Arctic, so the edge of the sea ice isn't a few huge facets.
    const cap = lat > 70 ? 260 : 560;
    return Math.min(cap, COAST_SPACING_KM * 1.15 + 0.5 * dCoast);
  };

  // Candidates, spread in proportion to the density wanted, from a fixed seed.
  const random = mulberry32(20261107);
  const candidates: Array<{
    p: Vec3;
    lat: number;
    lon: number;
    kind: number;
    spacing: number;
    dCoast: number;
  }> = [];
  const CELL_DEG = 0.25;
  const cellKm = CELL_DEG * DEG * EARTH_RADIUS_KM;
  for (let y = 0; y < 180 / CELL_DEG; y++) {
    const lat0 = 90 - (y + 1) * CELL_DEG;
    const lat1 = lat0 + CELL_DEG;
    const midLat = (lat0 + lat1) / 2;
    const area = cellKm * cellKm * Math.cos(midLat * DEG);
    for (let x = 0; x < 360 / CELL_DEG; x++) {
      const lon0 = -180 + x * CELL_DEG;
      const midLon = lon0 + CELL_DEG / 2;
      const kind = surfaceAt(midLat, midLon);
      const spacing = spacingAt(midLat, midLon, kind, distanceToCoast(midLat, midLon));
      const expected = (6 * area) / (0.87 * spacing * spacing);
      let count = Math.floor(expected);
      if (random() < expected - count) count++;
      for (let c = 0; c < count; c++) {
        const s0 = Math.sin(lat0 * DEG);
        const s1 = Math.sin(lat1 * DEG);
        const lat = Math.asin(s0 + (s1 - s0) * random()) / DEG;
        const lon = lon0 + CELL_DEG * random();
        const k = surfaceAt(lat, lon);
        const dCoast = distanceToCoast(lat, lon);
        candidates.push({
          p: latLonToVec3(lat, lon),
          lat,
          lon,
          kind: k,
          spacing: spacingAt(lat, lon, k, dCoast),
          dCoast,
        });
      }
    }
  }
  // A fixed shuffle decides which candidates win.
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
  }
  log(`${candidates.length} candidates`);

  // Accepted points.
  const coords: number[] = [];
  const kinds: number[] = [];
  const levels: number[] = [];
  const hash = new PointHash(coords, [16, 64, 256, 1024]);
  const coastCenters: number[] = [];
  const coastHash = new PointHash(coastCenters, [16, 64, 256]);
  const add = (p: Vec3, kind: number, level: number) => {
    const index = kinds.length;
    coords.push(p[0], p[1], p[2]);
    kinds.push(kind);
    levels.push(level);
    hash.insert(index);
    return index;
  };

  // The first point is in the emptiest ocean: the app projects the sphere from it.
  add(latLonToVec3(-48.88, -123.39), SURFACE.ocean, 0);

  const usedCandidate = new Uint8Array(candidates.length);
  const usedCoast = new Uint8Array(coast.length);
  const wholeRuns = new Set<number>();
  for (const [level, scale] of LEVEL_SCALES.entries()) {
    // Coastline pairs first, so the shapes come before the fill.
    const coastChord = kmToChord(COAST_SPACING_KM * scale * 0.92);
    for (let i = 0; i < coast.length; i++) {
      if (usedCoast[i]) continue;
      const sample = coast[i]!;
      // A small island comes in whole, so its water ring always surrounds its land.
      const whole = sample.runSize <= WHOLE_RUN_SAMPLES;
      if (!(whole && wholeRuns.has(sample.run)) && coastHash.anyWithin(sample.p, coastChord))
        continue;
      if (whole) wholeRuns.add(sample.run);
      usedCoast[i] = 1;
      const center = coastCenters.length / 3;
      coastCenters.push(...sample.p);
      coastHash.insert(center);
      const a = offsetAlong(sample.p, sample.across, COAST_OFFSET_KM);
      const b = offsetAlong(sample.p, sample.across, -COAST_OFFSET_KM);
      const la = vec3ToLatLon(...a);
      const lb = vec3ToLatLon(...b);
      const ka = surfaceAt(la.lat, la.lon);
      const kb = surfaceAt(lb.lat, lb.lon);
      // Both sides alike means a sliver of land or water narrower than the pair: leave it out.
      if (isSolid(ka) === isSolid(kb)) continue;
      const tooClose = kmToChord(COAST_OFFSET_KM * 0.9);
      if (!hash.anyWithin(a, tooClose)) add(a, ka, level);
      if (!hash.anyWithin(b, tooClose)) add(b, kb, level);
    }

    // Then the fill, keeping clear of the coastlines.
    for (let i = 0; i < candidates.length; i++) {
      if (usedCandidate[i]) continue;
      const c = candidates[i]!;
      if (c.dCoast < COAST_CLEARANCE_KM) continue;
      if (hash.anyWithin(c.p, kmToChord(c.spacing * scale * 0.88))) continue;
      usedCandidate[i] = 1;
      add(c.p, c.kind, level);
    }
    log(`level ${level}: ${kinds.length} points`);
  }

  // What each point is like.
  const count = kinds.length;
  const heights = new Float32Array(count);
  const biomes = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const p: Vec3 = [coords[i * 3]!, coords[i * 3 + 1]!, coords[i * 3 + 2]!];
    const { lat, lon } = vec3ToLatLon(...p);
    const kind = kinds[i]!;
    const spacing = spacingAt(lat, lon, kind, distanceToCoast(lat, lon));
    const around = footprint(p, Math.min(60, spacing * 0.5));
    if (kind === SURFACE.ocean) {
      // Depth averaged over the point's patch of sea, ignoring any land in it.
      let sum = 0;
      let n = 0;
      for (const q of around) {
        const g = vec3ToLatLon(...q);
        const h = etopo.at(g.lat, g.lon);
        if (h < 0) {
          sum += h;
          n++;
        }
      }
      heights[i] = n ? sum / n : -20;
    } else if (kind === SURFACE.lake) {
      // Lakes keep the height of their surface, which ETOPO5 mostly records.
      heights[i] = Math.max(0, etopo.at(lat, lon));
    } else {
      // Mostly the mean, with some of the peak, so ranges keep their crests.
      let sum = 0;
      let max = 0;
      let n = 0;
      const colorSums = months.map(() => [0, 0, 0] as Vec3);
      let colorCount = 0;
      let glaciated = 0;
      for (const q of around) {
        const g = vec3ToLatLon(...q);
        const h = Math.max(0, etopo.at(g.lat, g.lon));
        sum += h;
        max = Math.max(max, h);
        n++;
        if (isSolid(surfaceAt(g.lat, g.lon))) {
          months.forEach((image, m) => {
            const c = colorAt(image, g.lat, g.lon);
            colorSums[m]![0] += c[0];
            colorSums[m]![1] += c[1];
            colorSums[m]![2] += c[2];
          });
          colorCount++;
        }
        if (glacierMask[gridIndex(8192, 4096, g.lat, g.lon)]) glaciated++;
      }
      const height = kind === SURFACE.iceShelf ? 30 : (sum / n) * 0.7 + max * 0.3;
      heights[i] = height;
      const colors = colorSums.map(
        (s) =>
          (colorCount
            ? [s[0] / colorCount, s[1] / colorCount, s[2] / colorCount]
            : colorAt(months[1]!, lat, lon)) as Vec3,
      );
      const greenness = (c: Vec3) => (c[1] - c[0]) / (c[1] + c[0] + 0.001);
      const greener = greenness(colors[0]!) > greenness(colors[1]!) ? colors[0]! : colors[1]!;
      const brightness = (c: Vec3) => (c[0] + c[1] + c[2]) / 3;
      biomes[i] =
        kind === SURFACE.iceShelf
          ? BIOME.ice
          : classify(lat, height, {
              color: greener,
              minGreen: Math.min(greenness(colors[0]!), greenness(colors[1]!)),
              minBrightness: Math.min(brightness(colors[0]!), brightness(colors[1]!)),
              glaciated: glaciated > around.length / 3,
            });
    }
  }
  // One pass of a majority filter takes the speckle out of the biomes.
  const landIds = kinds.flatMap((kind, i) => (kind === SURFACE.land ? [i] : []));
  const landLatLon = landIds.map((i) =>
    vec3ToLatLon(coords[i * 3]!, coords[i * 3 + 1]!, coords[i * 3 + 2]!),
  );
  const landIndex = new KDBush(landIds.length);
  for (const { lat, lon } of landLatLon) landIndex.add(lon, lat);
  landIndex.finish();
  const smoothed = biomes.slice();
  landIds.forEach((id, j) => {
    const { lat, lon } = landLatLon[j]!;
    const votes = new Map<number, number>();
    for (const k of around(landIndex, lon, lat, 9, 200)) {
      const b = biomes[landIds[k]!]!;
      votes.set(b, (votes.get(b) ?? 0) + 1);
    }
    let best = biomes[id]!;
    let bestVotes = votes.get(best) ?? 0;
    for (const [b, v] of votes) {
      if (v > bestVotes && v >= 5) {
        best = b;
        bestVotes = v;
      }
    }
    // Ice and snow follow the data exactly; everything else may join its neighbors.
    if (biomes[id] !== BIOME.ice && biomes[id] !== BIOME.snow) smoothed[id] = best;
  });
  biomes.set(smoothed);
  log("measured heights and biomes");

  // Order: by level, then along a space-filling curve within each, which compresses well.
  const octa = new Uint16Array(count * 2);
  for (let i = 0; i < count; i++) {
    const [u, v] = encodeOctahedral(coords[i * 3]!, coords[i * 3 + 1]!, coords[i * 3 + 2]!);
    octa[i * 2] = u;
    octa[i * 2 + 1] = v;
  }
  const morton = (u: number, v: number) => {
    let code = 0;
    for (let bit = 15; bit >= 0; bit--) code = code * 4 + ((u >> bit) & 1) * 2 + ((v >> bit) & 1);
    return code;
  };
  const order = Array.from({ length: count }, (_, i) => i).sort((a, b) => {
    if (a === 0 || b === 0) return a === 0 ? -1 : 1;
    if (levels[a] !== levels[b]) return levels[a]! - levels[b]!;
    return morton(octa[a * 2]!, octa[a * 2 + 1]!) - morton(octa[b * 2]!, octa[b * 2 + 1]!);
  });

  const levelEnds = LEVEL_SCALES.map((_, level) => order.filter((i) => levels[i]! <= level).length);
  const positions = new Uint16Array(count * 2);
  const values = new Uint8Array(count);
  const infos = new Uint8Array(count);
  order.forEach((source, i) => {
    positions[i * 2] = octa[source * 2]!;
    positions[i * 2 + 1] = octa[source * 2 + 1]!;
    const kind = kinds[source]!;
    values[i] =
      kind === SURFACE.ocean ? encodeDepth(-heights[source]!) : encodeHeight(heights[source]!);
    infos[i] = packInfo(kind as 0 | 1 | 2 | 3, kind === SURFACE.ocean ? 0 : biomes[source]!);
  });

  const header: EarthHeader = {
    count,
    levels: levelEnds,
    tiers: { low: levelEnds[1]!, medium: levelEnds[3]!, high: levelEnds[4]! },
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));
  const headerLength = Math.ceil(headerBytes.length / 4) * 4;
  const body = 8 + headerLength;
  const file = new Uint8Array(body + positions.byteLength + values.length + infos.length);
  file.set(new TextEncoder().encode(EARTH_MAGIC), 0);
  new DataView(file.buffer).setUint32(4, headerLength, true);
  file.set(headerBytes, 8);
  file.fill(0x20, 8 + headerBytes.length, body);
  file.set(new Uint8Array(positions.buffer), body);
  file.set(values, body + positions.byteLength);
  file.set(infos, body + positions.byteLength + values.length);
  const packed = deflateSync(file, { level: 9 });
  writeFileSync(join(root, "public", "data", "earth.bin"), packed);

  const share = (kind: number) =>
    ((kinds.filter((k) => k === kind).length / count) * 100).toFixed(1);
  log(
    `earth.bin: ${count} points (${share(SURFACE.land)}% land, ${share(SURFACE.ocean)}% ocean, ${share(SURFACE.lake)}% lake), ` +
      `levels ${levelEnds.join(" / ")}, about ${count * 2 - 4} faces at full detail; ` +
      `${(file.length / 1024).toFixed(0)} KB raw, ${(packed.length / 1024).toFixed(0)} KB deflated`,
  );
}

await main();
