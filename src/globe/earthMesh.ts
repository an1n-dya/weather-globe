import { vec3ToLatLon } from '../geo/coords';
import { buildIcosphere, faceCount } from './icosphere';

export interface EarthArrays {
  /** Flat-shaded, non-indexed triangles: three corners per face. */
  positions: Float32Array;
  normals: Float32Array;
  colors: Uint8Array;
}

type Rgb = readonly [number, number, number];

const OCEAN_DEEP: Rgb = [0.17, 0.45, 0.68];
const OCEAN_MID: Rgb = [0.21, 0.52, 0.74];
const OCEAN_SHALLOW: Rgb = [0.33, 0.68, 0.78];
const SEA_ICE: Rgb = [0.78, 0.88, 0.93];
const ICE: Rgb = [0.93, 0.96, 0.97];
const TUNDRA: Rgb = [0.6, 0.65, 0.54];
const TAIGA: Rgb = [0.33, 0.56, 0.42];
const TEMPERATE: Rgb = [0.45, 0.68, 0.4];
const TROPICAL: Rgb = [0.27, 0.6, 0.36];
const SAVANNA: Rgb = [0.7, 0.7, 0.4];
const DESERT: Rgb = [0.87, 0.75, 0.5];

function hash3(x: number, y: number, z: number): number {
  const h = Math.sin(x * 127.1 + y * 311.7 + z * 74.7) * 43758.5453;
  return h - Math.floor(h);
}

/** Smooth 3D value noise in [0, 1]. */
function noise3(x: number, y: number, z: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const zi = Math.floor(z);
  const fade = (t: number) => t * t * (3 - 2 * t);
  const u = fade(x - xi);
  const v = fade(y - yi);
  const w = fade(z - zi);
  const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
  return lerp(
    lerp(
      lerp(hash3(xi, yi, zi), hash3(xi + 1, yi, zi), u),
      lerp(hash3(xi, yi + 1, zi), hash3(xi + 1, yi + 1, zi), u),
      v,
    ),
    lerp(
      lerp(hash3(xi, yi, zi + 1), hash3(xi + 1, yi, zi + 1), u),
      lerp(hash3(xi, yi + 1, zi + 1), hash3(xi + 1, yi + 1, zi + 1), u),
      v,
    ),
    w,
  );
}

function fractalNoise(x: number, y: number, z: number): number {
  return (
    noise3(x * 3, y * 3, z * 3) * 0.55 +
    noise3(x * 7, y * 7, z * 7) * 0.3 +
    noise3(x * 15, y * 15, z * 15) * 0.15
  );
}

const inside = (v: number, min: number, max: number) => v >= min && v <= max;

/** Cosmetic colors chosen by rough climate regions, not real land-cover data. */
function landColor(lat: number, lon: number, n: number): Rgb {
  // Bends the region edges, so no straight lines show.
  const wobble = (n - 0.5) * 34;
  const la = lat + wobble;
  const abs = Math.abs(la);

  if (lat < -60 || abs > 76) return ICE;
  if (inside(lat, 60, 84) && inside(lon, -73, -12)) return ICE; // Greenland
  if (abs > 64) return TUNDRA;
  if (abs > 50) return TAIGA;

  const lo = lon + wobble;
  const arid =
    (inside(la, 15, 33) && inside(lo, -18, 60)) || // Sahara, Arabia
    (inside(la, 36, 47) && inside(lo, 52, 106)) || // Central Asia
    (inside(la, 23, 31) && inside(lo, 60, 74)) || // Thar, Iran
    (inside(la, -32, -20) && inside(lo, 117, 143)) || // Australian interior
    (inside(la, -29, -20) && inside(lo, 14, 25)) || // Kalahari, Namib
    (inside(la, -30, -16) && inside(lo, -72, -67)) || // Atacama
    (inside(la, 27, 40) && inside(lo, -118, -103)); // US southwest
  if (arid) return DESERT;

  if (abs < 11) return TROPICAL;
  if (abs < 17) return n > 0.5 ? SAVANNA : TROPICAL;
  if (abs < 22) return n > 0.42 ? SAVANNA : TEMPERATE;
  return TEMPERATE;
}

function oceanColor(lat: number, n: number, shallow: boolean): Rgb {
  if (Math.abs(lat) + (n - 0.5) * 8 > 83) return SEA_ICE;
  if (shallow) return OCEAN_SHALLOW;
  // A gradual blend: a hard threshold here reads as camouflage patches.
  const t = Math.max(0, Math.min(1, (n - 0.35) / 0.3));
  return [
    OCEAN_DEEP[0] + (OCEAN_MID[0] - OCEAN_DEEP[0]) * t,
    OCEAN_DEEP[1] + (OCEAN_MID[1] - OCEAN_DEEP[1]) * t,
    OCEAN_DEEP[2] + (OCEAN_MID[2] - OCEAN_DEEP[2]) * t,
  ];
}

export function buildEarthArrays(frequency: number, mask: Uint8Array): EarthArrays {
  const faceTotal = faceCount(frequency);
  if (mask.length < Math.ceil(faceTotal / 8)) {
    throw new Error(`Land mask too small for frequency ${frequency}`);
  }

  const { vertices, faces } = buildIcosphere(frequency);
  const vertexTotal = vertices.length / 3;
  const isLandFace = (f: number) => (mask[f >> 3] & (1 << (f & 7))) !== 0;

  // A vertex is coastal if only some of the faces around it are land.
  const landTouches = new Uint8Array(vertexTotal);
  const allTouches = new Uint8Array(vertexTotal);
  for (let f = 0; f < faceTotal; f++) {
    const land = isLandFace(f);
    for (let c = 0; c < 3; c++) {
      const v = faces[f * 3 + c];
      allTouches[v]++;
      if (land) landTouches[v]++;
    }
  }

  const radii = new Float32Array(vertexTotal);
  for (let v = 0; v < vertexTotal; v++) {
    if (landTouches[v] === 0) {
      radii[v] = 1;
    } else if (landTouches[v] < allTouches[v]) {
      radii[v] = 1.005;
    } else {
      const x = vertices[v * 3];
      const y = vertices[v * 3 + 1];
      const z = vertices[v * 3 + 2];
      const n = fractalNoise(x + 11, y + 5, z + 3);
      radii[v] = 1.009 + Math.pow(Math.max(0, n - 0.42), 1.5) * 0.08;
    }
  }

  const positions = new Float32Array(faceTotal * 9);
  const normals = new Float32Array(faceTotal * 9);
  const colors = new Uint8Array(faceTotal * 9);

  for (let f = 0; f < faceTotal; f++) {
    const ia = faces[f * 3];
    const ib = faces[f * 3 + 1];
    const ic = faces[f * 3 + 2];

    const corner = (v: number) => {
      const r = radii[v];
      return [vertices[v * 3] * r, vertices[v * 3 + 1] * r, vertices[v * 3 + 2] * r];
    };
    const a = corner(ia);
    const b = corner(ib);
    const c = corner(ic);

    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const uz = b[2] - a[2];
    const vx = c[0] - a[0];
    const vy = c[1] - a[1];
    const vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const nLength = Math.hypot(nx, ny, nz) || 1;
    nx /= nLength;
    ny /= nLength;
    nz /= nLength;

    const cx = (a[0] + b[0] + c[0]) / 3;
    const cy = (a[1] + b[1] + c[1]) / 3;
    const cz = (a[2] + b[2] + c[2]) / 3;
    const { lat, lon } = vec3ToLatLon(cx, cy, cz);
    const n = fractalNoise(cx * 1.4 + 2, cy * 1.4 + 7, cz * 1.4 + 13);

    const land = isLandFace(f);
    const shallow = landTouches[ia] > 0 || landTouches[ib] > 0 || landTouches[ic] > 0;
    const base = land ? landColor(lat, lon, n) : oceanColor(lat, n, shallow);
    // Small per-face variation is what makes the facets read.
    const jitter = (land ? 0.93 : 0.97) + hash3(cx * 91, cy * 91, cz * 91) * (land ? 0.14 : 0.06);
    const red = Math.min(255, base[0] * jitter * 255);
    const green = Math.min(255, base[1] * jitter * 255);
    const blue = Math.min(255, base[2] * jitter * 255);

    const offset = f * 9;
    const tri = [a, b, c];
    for (let k = 0; k < 3; k++) {
      positions[offset + k * 3] = tri[k][0];
      positions[offset + k * 3 + 1] = tri[k][1];
      positions[offset + k * 3 + 2] = tri[k][2];
      normals[offset + k * 3] = nx;
      normals[offset + k * 3 + 1] = ny;
      normals[offset + k * 3 + 2] = nz;
      colors[offset + k * 3] = red;
      colors[offset + k * 3 + 1] = green;
      colors[offset + k * 3 + 2] = blue;
    }
  }

  return { positions, normals, colors };
}
