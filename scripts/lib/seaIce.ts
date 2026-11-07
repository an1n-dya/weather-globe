import { DEG } from "../../src/geo/coords";
import { cachedDownload } from "./download";
import { readTiff8, type Tiff8 } from "./tiff";

/**
 * Monthly sea ice from the NSIDC Sea Ice Index (version 4): where the sea is
 * at least 15% ice-covered, on 25 km polar grids. A month counts as frozen
 * where most of the recent years agree, which evens out a single odd year.
 */
const YEARS = [2023, 2024, 2025];
const MONTH_FOLDERS = [
  "01_Jan",
  "02_Feb",
  "03_Mar",
  "04_Apr",
  "05_May",
  "06_Jun",
  "07_Jul",
  "08_Aug",
  "09_Sep",
  "10_Oct",
  "11_Nov",
  "12_Dec",
];
const ICE = 1;
/** Older grids mark the satellites' blind spot around the North Pole, which is always frozen. */
const POLE_HOLE = 251;
const COAST = 253;
const LAND = 254;
const NOT_SEA = 255;

/** The Hughes 1980 ellipsoid, which the grids are drawn on. */
const A = 6378273;
const B = 6356889.449;
const E = Math.sqrt(1 - (B / A) ** 2);
const TRUE_SCALE = 70 * DEG;

/** NSIDC's polar stereographic projections: EPSG:3411 in the north, EPSG:3412 in the south. */
export function polarStereographic(lat: number, lon: number): [number, number] {
  const north = lat > 0;
  const t = (phi: number) =>
    Math.tan(Math.PI / 4 - phi / 2) /
    ((1 - E * Math.sin(phi)) / (1 + E * Math.sin(phi))) ** (E / 2);
  const scale = Math.cos(TRUE_SCALE) / Math.sqrt(1 - (E * Math.sin(TRUE_SCALE)) ** 2);
  const rho = (A * scale * t(Math.abs(lat) * DEG)) / t(TRUE_SCALE);
  const lambda = (lon - (north ? -45 : 0)) * DEG;
  return [rho * Math.sin(lambda), (north ? -rho : rho) * Math.cos(lambda)];
}

interface MonthGrid {
  grid: Tiff8;
  /** Years with ice at each cell, or NOT_SEA for land and coast. */
  votes: Uint8Array;
}

export interface SeaIce {
  /**
   * Whether the sea at a place is usually frozen in a month (0 is January),
   * or null where the grids say land or coast, or don't reach.
   */
  frozen(lat: number, lon: number, month: number): boolean | null;
}

export async function loadSeaIce(): Promise<SeaIce> {
  const hemispheres = { north: [] as MonthGrid[], south: [] as MonthGrid[] };
  for (const hemisphere of ["north", "south"] as const) {
    for (let month = 0; month < 12; month++) {
      let combined: MonthGrid | null = null;
      for (const year of YEARS) {
        const name = `${hemisphere === "north" ? "N" : "S"}_${year}${String(month + 1).padStart(2, "0")}_extent_v4.0.tif`;
        const grid = readTiff8(
          await cachedDownload(
            `https://noaadata.apps.nsidc.org/NOAA/G02135/${hemisphere}/monthly/geotiff/${MONTH_FOLDERS[month]}/${name}`,
            `nsidc-${name}`,
          ),
        );
        combined ??= { grid, votes: new Uint8Array(grid.data.length) };
        const { votes } = combined;
        for (let i = 0; i < grid.data.length; i++) {
          const value = grid.data[i]!;
          if (value === LAND || value === COAST) votes[i] = NOT_SEA;
          else if (votes[i] !== NOT_SEA && (value === ICE || value === POLE_HOLE)) votes[i]!++;
        }
      }
      hemispheres[hemisphere].push(combined!);
    }
  }
  return {
    frozen(lat, lon, month) {
      const { grid, votes } = hemispheres[lat > 0 ? "north" : "south"][month]!;
      const [x, y] = polarStereographic(lat, lon);
      const col = Math.floor((x - grid.originX) / grid.pixelWidth);
      const row = Math.floor((grid.originY - y) / grid.pixelHeight);
      if (col < 0 || row < 0 || col >= grid.width || row >= grid.height) return null;
      const vote = votes[row * grid.width + col]!;
      return vote === NOT_SEA ? null : vote * 2 > YEARS.length;
    },
  };
}
