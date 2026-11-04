/**
 * Turns Natural Earth vectors (public domain) into:
 *   public/data/land-grid.bin          a 720x360 lat/lon bit grid, for "ocean or land?"
 *   public/textures/water-<size>.webp  an anti-aliased water mask, oceans and large
 *                                      lakes, which the globe uses for reflections
 *
 * d3-geo's equirectangular projection handles the antimeridian and pole
 * clipping; the resulting planar rings are filled with an even-odd scanline.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type ExtendedFeatureCollection,
  type GeoPermissibleObjects,
  geoArea,
  geoEquirectangular,
  geoPath,
} from "d3-geo";
import sharp from "sharp";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";

const LAKES_SOURCE =
  "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_50m_lakes.geojson";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "public", "data");
const textureDir = join(root, "public", "textures");
mkdirSync(dataDir, { recursive: true });
mkdirSync(textureDir, { recursive: true });

const WIDTH = 8192;
const HEIGHT = 4096;

/** One byte per pixel, 1 inside the shapes, on an 8192x4096 equirectangular grid. */
function rasterize(shapes: GeoPermissibleObjects): Uint8Array {
  const projection = geoEquirectangular()
    .scale(WIDTH / (2 * Math.PI))
    .translate([WIDTH / 2, HEIGHT / 2])
    .precision(0.1);

  const crossings: number[][] = Array.from({ length: HEIGHT }, () => []);
  let start: [number, number] | null = null;
  let previous: [number, number] | null = null;

  const addEdge = (a: [number, number], b: [number, number]) => {
    const [x0, y0] = a;
    const [x1, y1] = b;
    if (y0 === y1) return;
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const firstRow = Math.max(0, Math.ceil(top - 0.5));
    const lastRow = Math.min(HEIGHT - 1, Math.ceil(bottom - 0.5) - 1);
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row + 0.5;
      crossings[row]!.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
  };

  const context = {
    beginPath() {},
    moveTo(x: number, y: number) {
      start = [x, y];
      previous = start;
    },
    lineTo(x: number, y: number) {
      const point: [number, number] = [x, y];
      if (previous) addEdge(previous, point);
      previous = point;
    },
    closePath() {
      if (previous && start) addEdge(previous, start);
      previous = start;
    },
    arc() {},
  };

  geoPath(projection, context as unknown as CanvasRenderingContext2D)(shapes);

  const bitmap = new Uint8Array(WIDTH * HEIGHT);
  for (let row = 0; row < HEIGHT; row++) {
    const xs = crossings[row]!.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const to = Math.min(WIDTH - 1, Math.ceil(xs[i + 1]! - 0.5) - 1);
      if (to >= from) bitmap.fill(1, row * WIDTH + from, row * WIDTH + to + 1);
    }
  }
  return bitmap;
}

function loadLand(): GeoPermissibleObjects {
  const topology = JSON.parse(
    readFileSync(join(root, "node_modules/world-atlas/land-50m.json"), "utf8"),
  ) as Topology<{ land: GeometryCollection }>;
  return feature(topology, topology.objects.land);
}

type Ring = Array<[number, number]>;

/**
 * d3-geo reads a ring's winding to decide which side is inside, and these
 * files wind the other way, so an unfixed lake would cover the rest of the world.
 */
async function loadLakes(): Promise<ExtendedFeatureCollection> {
  const response = await fetch(LAKES_SOURCE);
  if (!response.ok) throw new Error(`Lakes download failed: HTTP ${response.status}`);
  const lakes = (await response.json()) as ExtendedFeatureCollection;
  for (const lake of lakes.features) {
    if (geoArea(lake) <= 2 * Math.PI) continue;
    const geometry = lake.geometry as
      | { type: "Polygon"; coordinates: Ring[] }
      | { type: "MultiPolygon"; coordinates: Ring[][] };
    const polygons = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    for (const polygon of polygons) for (const ring of polygon) ring.reverse();
  }
  return lakes;
}

function buildGrid(land: Uint8Array): Uint8Array {
  const gridW = 720;
  const gridH = 360;
  const grid = new Uint8Array(Math.ceil((gridW * gridH) / 8));
  for (let y = 0; y < gridH; y++) {
    const rowStart = Math.floor((y * HEIGHT) / gridH);
    const rowEnd = Math.floor(((y + 1) * HEIGHT) / gridH);
    for (let x = 0; x < gridW; x++) {
      const colStart = Math.floor((x * WIDTH) / gridW);
      const colEnd = Math.floor(((x + 1) * WIDTH) / gridW);
      let count = 0;
      for (let py = rowStart; py < rowEnd; py++) {
        for (let px = colStart; px < colEnd; px++) count += land[py * WIDTH + px]!;
      }
      if (count >= (rowEnd - rowStart) * (colEnd - colStart) * 0.25) {
        const bit = y * gridW + x;
        grid[bit >> 3]! |= 1 << (bit & 7);
      }
    }
  }
  return grid;
}

/** Averages factor x factor blocks, giving anti-aliased coastlines. */
function downsample(bitmap: Uint8Array, factor: number): Uint8Array {
  const width = WIDTH / factor;
  const height = HEIGHT / factor;
  const out = new Uint8Array(width * height);
  const scale = 255 / (factor * factor);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * WIDTH + x * factor;
        for (let dx = 0; dx < factor; dx++) sum += bitmap[row + dx]!;
      }
      out[y * width + x] = Math.round(sum * scale);
    }
  }
  return out;
}

const land = rasterize(loadLand());
const lakes = rasterize(await loadLakes());
writeFileSync(join(dataDir, "land-grid.bin"), buildGrid(land));

const water = new Uint8Array(WIDTH * HEIGHT);
for (let i = 0; i < water.length; i++) water[i] = land[i] && !lakes[i] ? 0 : 1;

for (const [factor, size] of [
  [2, "4k"],
  [4, "2k"],
] as const) {
  const pixels = downsample(water, factor);
  const file = join(textureDir, `water-${size}.webp`);
  const info = await sharp(pixels, {
    raw: { width: WIDTH / factor, height: HEIGHT / factor, channels: 1 },
  })
    .webp({ lossless: true, effort: 6 })
    .toFile(file);
  console.log(`${file}: ${(info.size / 1024).toFixed(0)} KB`);
}
console.log("land data written to public/data and public/textures");
