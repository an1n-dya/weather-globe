/**
 * Turns Natural Earth land polygons into land-mask-<frequency>.bin: one bit
 * per icosphere face, for the globe mesh. "Land or water?" for place names
 * comes from regions.bin instead (scripts/build-regions.ts).
 *
 * d3-geo's equirectangular projection handles the antimeridian and pole
 * clipping; the resulting planar rings are filled with an even-odd scanline.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { geoEquirectangular, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { vec3ToLatLon } from "../src/geo/coords";
import { buildIcosphere, FREQUENCY_HIGH, FREQUENCY_LOW } from "../src/globe/icosphere";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "public", "data");
mkdirSync(outDir, { recursive: true });

const WIDTH = 8192;
const HEIGHT = 4096;

function rasterizeLand(): Uint8Array {
  const topology = JSON.parse(
    readFileSync(join(root, "node_modules/world-atlas/land-50m.json"), "utf8"),
  ) as Topology<{ land: GeometryCollection }>;
  const land = feature(topology, topology.objects.land);

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

  geoPath(projection, context as unknown as CanvasRenderingContext2D)(land);

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

function sample(bitmap: Uint8Array, lat: number, lon: number): boolean {
  const x = Math.min(WIDTH - 1, Math.floor(((lon + 180) / 360) * WIDTH));
  const y = Math.min(HEIGHT - 1, Math.floor(((90 - lat) / 180) * HEIGHT));
  return bitmap[y * WIDTH + x] === 1;
}

function buildFaceMask(bitmap: Uint8Array, frequency: number): Uint8Array {
  const { vertices, faces } = buildIcosphere(frequency);
  const faceTotal = faces.length / 3;
  const mask = new Uint8Array(Math.ceil(faceTotal / 8));
  let landFaces = 0;

  for (let f = 0; f < faceTotal; f++) {
    const a = faces[f * 3]! * 3;
    const b = faces[f * 3 + 1]! * 3;
    const c = faces[f * 3 + 2]! * 3;
    const cx = (vertices[a]! + vertices[b]! + vertices[c]!) / 3;
    const cy = (vertices[a + 1]! + vertices[b + 1]! + vertices[c + 1]!) / 3;
    const cz = (vertices[a + 2]! + vertices[b + 2]! + vertices[c + 2]!) / 3;

    // The center plus points halfway to each corner, so narrow land survives.
    const center = vec3ToLatLon(cx, cy, cz);
    let hits = sample(bitmap, center.lat, center.lon) ? 1 : 0;
    for (const v of [a, b, c]) {
      const p = vec3ToLatLon(
        (cx + vertices[v]!) / 2,
        (cy + vertices[v + 1]!) / 2,
        (cz + vertices[v + 2]!) / 2,
      );
      if (sample(bitmap, p.lat, p.lon)) hits++;
    }

    if (hits >= 2) {
      mask[f >> 3]! |= 1 << (f & 7);
      landFaces++;
    }
  }

  const share = ((landFaces / faceTotal) * 100).toFixed(1);
  console.log(`frequency ${frequency}: ${faceTotal} faces, ${share}% land, ${mask.length} bytes`);
  return mask;
}

const bitmap = rasterizeLand();
for (const frequency of [FREQUENCY_HIGH, FREQUENCY_LOW]) {
  writeFileSync(join(outDir, `land-mask-${frequency}.bin`), buildFaceMask(bitmap, frequency));
}
console.log("land data written to public/data");
