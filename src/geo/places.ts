import { around, distance as kmBetween } from "geokdbush";
import KDBush from "kdbush";
import { dataUrl } from "../data";
import { normalizeLon } from "./coords";

type PlaceKind = "city" | "near" | "ocean" | "remote" | "unknown";

export interface Place {
  kind: PlaceKind;
  name: string;
  /** Country name, when known. */
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
    private readonly landGrid: Uint8Array,
  ) {
    this.index = new KDBush(cities.length);
    for (const city of cities) this.index.add(city[3], city[2]);
    this.index.finish();
  }

  isLand(lat: number, lon: number): boolean {
    const x = Math.min(719, Math.floor((normalizeLon(lon) + 180) * 2));
    const y = Math.max(0, Math.min(359, Math.floor((90 - lat) * 2)));
    const bit = y * 720 + x;
    return ((this.landGrid[bit >> 3] ?? 0) & (1 << (bit & 7))) !== 0;
  }

  placeAt(lat: number, lon: number): Place {
    const lng = normalizeLon(lon);

    // Favors larger places, so a suburb does not beat its own city.
    let best: { row: CityRow; km: number; score: number } | null = null;
    for (const id of around(this.index, lng, lat, 12, SEARCH_RADIUS_KM)) {
      const row = this.cities[id];
      if (!row) continue;
      const km = kmBetween(lng, lat, row[3], row[2]);
      const score = km / (1 + 1.2 * Math.log10(Math.max(row[4], 15_000) / 15_000));
      if (!best || score < best.score) best = { row, km, score };
    }

    if (best) {
      return {
        kind: best.km <= AT_CITY_KM ? "city" : "near",
        name: best.km <= AT_CITY_KM ? best.row[0] : `Near ${best.row[0]}`,
        region: countryName(best.row[1]),
      };
    }
    return this.isLand(lat, lng)
      ? { kind: "remote", name: "Remote area", region: "" }
      : { kind: "ocean", name: "Open ocean", region: "" };
  }
}

export async function loadPlaceIndex(): Promise<{ index: PlaceIndex; cities: CityRow[] }> {
  const [citiesResponse, gridResponse] = await Promise.all([
    fetch(dataUrl("cities.json")),
    fetch(dataUrl("land-grid.bin")),
  ]);
  if (!citiesResponse.ok || !gridResponse.ok) throw new Error("Could not load place data");
  const cities = (await citiesResponse.json()) as CityRow[];
  const grid = new Uint8Array(await gridResponse.arrayBuffer());
  return { index: new PlaceIndex(cities, grid), cities };
}
