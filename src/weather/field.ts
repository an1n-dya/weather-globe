import { DEG, latLonToVec3, normalizeLon } from "../geo/coords";
import type { Sky } from "./conditions";

export interface SkySample {
  lat: number;
  lon: number;
  sky: Sky;
}

/** 2° cells: about as fine as a couple of hundred samples can honestly fill. */
export const FIELD_WIDTH = 180;
export const FIELD_HEIGHT = 90;

/**
 * Clouds spread wide around a sample; rain stays closer, as showers are
 * smaller than the cloud decks that carry them.
 */
const CLOUD_SIGMA = 7 * DEG;
const PRECIP_SIGMA = 3.6 * DEG;
const CUTOFF_SIGMAS = 3;

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));
const gauss = (x: number, width: number) => Math.exp(-(x * x) / (2 * width * width));

type Region = readonly [south: number, north: number, west: number, east: number, change: number];

/** 1 inside a region's lat/lon box, fading to 0 over `soft` degrees outside it. */
function inRegion(lat: number, lon: number, [s, n, w, e]: Region, soft: number): number {
  const fade = (inside: number) => clamp01(1 + inside / soft);
  return Math.min(fade(lat - s), fade(n - lat), fade(lon - w), fade(e - lon));
}

const DESERTS: Region[] = [
  [15, 32, -15, 55, -0.38], // Sahara, Arabia
  [24, 33, 52, 73, -0.25], // Iran, Thar
  [37, 47, 75, 110, -0.2], // Taklamakan, Gobi
  [-32, -19, 118, 142, -0.3], // Australian interior
  [-28, -18, 13, 25, -0.25], // Kalahari, Namib
  [25, 37, -117, -103, -0.22], // US Southwest
] as const;

const CLOUD_DECKS: Region[] = [
  [-30, -5, -95, -75, 0.25], // off Peru and Chile
  [18, 35, -135, -118, 0.2], // off California
  [-25, -5, -10, 12, 0.25], // off Namibia and Angola
  [-35, -20, 90, 112, 0.15], // off Western Australia
  [-10, 5, -75, -45, 0.1], // Amazon
  [-5, 5, 10, 30, 0.1], // Congo
  [-10, 8, 95, 150, 0.12], // Maritime continent
] as const;

/**
 * A rough seasonal cloud climatology, for where no sample reaches: the
 * equatorial rain belt following the sun, clearer subtropics, the storm tracks
 * of the middle latitudes, and the main deserts and ocean cloud decks.
 */
export function climateCloud(lat: number, lon: number, dayOfYear: number): number {
  // +1 at the June solstice, -1 at the December one.
  const season = Math.sin(((dayOfYear - 80) / 365.25) * 2 * Math.PI);
  let cloud =
    0.42 +
    0.28 * gauss(lat - (5 + 5 * season), 7) -
    0.16 * gauss(lat - (22 + 4 * season), 8) -
    0.16 * gauss(lat + (22 - 4 * season), 8) +
    0.3 * gauss(lat - (55 - 3 * season), 12) +
    0.4 * gauss(lat + 57, 10) +
    0.1 * gauss(Math.abs(lat) - 75, 10);
  const wrapped = normalizeLon(lon);
  for (const region of [...DESERTS, ...CLOUD_DECKS]) {
    cloud += region[4] * inRegion(lat, wrapped, region, 6);
  }
  return Math.max(0.05, Math.min(0.92, cloud));
}

export function dayOfYear(date: Date): number {
  const start = Date.UTC(date.getUTCFullYear(), 0, 0);
  return (date.getTime() - start) / 86_400_000;
}

/**
 * Spreads point samples over an equirectangular RGBA grid, north row first:
 * red is cloud cover, green precipitation, blue the share of it that is snow,
 * alpha lightning. Far from every sample, clouds fall back to the climatology
 * and precipitation to none, so nothing is invented where nothing is known.
 */
export function buildSkyField(
  samples: ReadonlyArray<SkySample>,
  date: Date,
  width = FIELD_WIDTH,
  height = FIELD_HEIGHT,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(width * height * 4);
  const points = samples.map(({ lat, lon, sky }) => {
    const [x, y, z] = latLonToVec3(lat, lon);
    return { x, y, z, sky };
  });
  const day = dayOfYear(date);
  const cloudCutoff = (CUTOFF_SIGMAS * CLOUD_SIGMA) ** 2;
  const precipCutoff = (CUTOFF_SIGMAS * PRECIP_SIGMA) ** 2;
  const cloudScale = 1 / (2 * CLOUD_SIGMA * CLOUD_SIGMA);
  const precipScale = 1 / (2 * PRECIP_SIGMA * PRECIP_SIGMA);

  for (let y = 0; y < height; y++) {
    const lat = 90 - ((y + 0.5) * 180) / height;
    for (let x = 0; x < width; x++) {
      const lon = -180 + ((x + 0.5) * 360) / width;
      const [px, py, pz] = latLonToVec3(lat, lon);
      let cloudWeight = 0;
      let cloudSum = 0;
      let precipWeight = 0;
      let precipSum = 0;
      let snowSum = 0;
      let thunderSum = 0;

      for (const { x: sx, y: sy, z: sz, sky } of points) {
        // Squared chord length, close to the squared angle at these distances.
        const d2 = 2 - 2 * (px * sx + py * sy + pz * sz);
        if (d2 > cloudCutoff) continue;
        const wc = Math.exp(-d2 * cloudScale);
        cloudWeight += wc;
        cloudSum += wc * sky.cloud;
        if (d2 > precipCutoff) continue;
        const wp = Math.exp(-d2 * precipScale);
        precipWeight += wp;
        precipSum += wp * sky.precip;
        snowSum += wp * sky.precip * sky.snow;
        thunderSum += wp * sky.thunder;
      }

      const prior = climateCloud(lat, lon, day);
      const confidence = Math.min(1, cloudWeight);
      const measured = cloudWeight > 0 ? cloudSum / cloudWeight : prior;
      const cloud = prior + (measured - prior) * confidence;
      // Dividing by at least 1 lets precipitation fade out away from wet samples.
      const precip = precipSum / Math.max(1, precipWeight);
      const snow = precipSum > 1e-6 ? snowSum / precipSum : 0;
      const thunder = thunderSum / Math.max(1, precipWeight);

      const o = (y * width + x) * 4;
      out[o] = Math.round(clamp01(cloud) * 255);
      out[o + 1] = Math.round(clamp01(precip) * 255);
      out[o + 2] = Math.round(clamp01(snow) * 255);
      out[o + 3] = Math.round(clamp01(thunder) * 255);
    }
  }
  return out;
}

/** Bilinear lookup in a field from `buildSkyField`, wrapping in longitude. */
export function sampleSkyField(
  field: Uint8Array,
  lat: number,
  lon: number,
  width = FIELD_WIDTH,
  height = FIELD_HEIGHT,
): { cloud: number; precip: number; snow: number; thunder: number } {
  const fx = ((normalizeLon(lon) + 180) / 360) * width - 0.5;
  const fy = Math.max(0, Math.min(height - 1, ((90 - lat) / 180) * height - 0.5));
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const tx = fx - x0;
  const ty = fy - y0;
  const y1 = Math.min(height - 1, y0 + 1);
  const at = (x: number, y: number, c: number) =>
    (field[(y * width + (((x % width) + width) % width)) * 4 + c] ?? 0) / 255;
  const channel = (c: number) =>
    (at(x0, y0, c) * (1 - tx) + at(x0 + 1, y0, c) * tx) * (1 - ty) +
    (at(x0, y1, c) * (1 - tx) + at(x0 + 1, y1, c) * tx) * ty;
  return { cloud: channel(0), precip: channel(1), snow: channel(2), thunder: channel(3) };
}
