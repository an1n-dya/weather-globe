import { around, distance as kmBetween } from "geokdbush";
import KDBush from "kdbush";
import { dataUrl } from "../data";
import { inflate } from "../inflate";
import { normalizeLon } from "./coords";
import { Regions, SURFACE } from "./regions";

type PlaceKind = "city" | "near" | "ocean" | "lake" | "remote" | "unknown";

export interface Place {
  kind: PlaceKind;
  name: string;
  /** Country name, or for open water the nearest town, when known. */
  region: string;
}

/** [name, country code, lat, lon, population] */
export type CityRow = [string, string, number, number, number];

const SEARCH_RADIUS_KM = 150;
/** Within this distance a place is named outright; further away it is "Near X". */
const AT_CITY_KM = 25;

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

export function countryName(code: string): string {
  try {
    return regionNames.of(code) ?? code;
  } catch {
    return code;
  }
}

export class PlaceIndex {
  private readonly index: KDBush;

  constructor(
    private readonly cities: ReadonlyArray<CityRow>,
    private readonly regions: Regions,
  ) {
    this.index = new KDBush(Math.max(1, cities.length));
    for (const city of cities) this.index.add(city[3], city[2]);
    this.index.finish();
  }

  isLand(lat: number, lon: number): boolean {
    return this.regions.isLand(lat, lon);
  }

  /** The best-known town nearby, favoring larger places so a suburb does not beat its own city. */
  private nearestTown(lat: number, lon: number): { row: CityRow; km: number } | null {
    let best: { row: CityRow; km: number; score: number } | null = null;
    for (const id of around(this.index, lon, lat, 12, SEARCH_RADIUS_KM)) {
      const row = this.cities[id];
      if (!row) continue;
      const km = kmBetween(lon, lat, row[3], row[2]);
      const score = km / (1 + 1.2 * Math.log10(Math.max(row[4], 15_000) / 15_000));
      if (!best || score < best.score) best = { row, km, score };
    }
    return best;
  }

  placeAt(lat: number, lon: number): Place {
    const lng = normalizeLon(lon);
    const surface = this.regions.surfaceAt(lat, lng);
    const town = this.nearestTown(lat, lng);

    // A town's own waterfront still goes by the town's name.
    if (town && town.km <= AT_CITY_KM) {
      return { kind: "city", name: town.row[0], region: countryName(town.row[1]) };
    }
    if (surface === SURFACE.ocean) {
      return {
        kind: "ocean",
        name: this.regions.seaAt(lat, lng) || "Open ocean",
        region: town ? `Near ${town.row[0]}, ${countryName(town.row[1])}` : "",
      };
    }
    if (surface === SURFACE.lake) {
      return {
        kind: "lake",
        name: this.regions.lakeAt(lat, lng) || "Lake",
        region: this.regions.countryAt(lat, lng),
      };
    }
    if (town) {
      return { kind: "near", name: `Near ${town.row[0]}`, region: countryName(town.row[1]) };
    }
    const fallback = surface === SURFACE.iceShelf ? "Ice shelf" : "Remote area";
    return {
      kind: "remote",
      name: this.regions.regionAt(lat, lng) || fallback,
      region: this.regions.countryAt(lat, lng),
    };
  }
}

export async function loadRegions(): Promise<Regions> {
  const response = await fetch(dataUrl("regions.bin"));
  if (!response.ok) throw new Error(`Could not load region data: HTTP ${response.status}`);
  return new Regions(await inflate(new Uint8Array(await response.arrayBuffer())));
}

export async function loadPlaceIndex(): Promise<{ index: PlaceIndex; cities: CityRow[] }> {
  const [citiesResponse, regions] = await Promise.all([
    fetch(dataUrl("cities.json")),
    loadRegions(),
  ]);
  if (!citiesResponse.ok)
    throw new Error(`Could not load place data: HTTP ${citiesResponse.status}`);
  const cities = parseCityRows(await citiesResponse.json());
  return { index: new PlaceIndex(cities, regions), cities };
}

/** Keeps only well-formed rows, so a damaged file can't put NaN on screen. */
export function parseCityRows(raw: unknown): CityRow[] {
  if (!Array.isArray(raw)) throw new Error("Place data is not a list");
  return raw.filter(
    (row): row is CityRow =>
      Array.isArray(row) &&
      typeof row[0] === "string" &&
      typeof row[1] === "string" &&
      Number.isFinite(row[2]) &&
      Number.isFinite(row[3]) &&
      Number.isFinite(row[4]),
  );
}
