/**
 * Downloads the GeoNames cities15000 dump (CC BY 4.0) and writes:
 *   public/data/cities.bin     every town for nearest-place names and night lights
 *                              (columns, deflated; see src/geo/citiesData.ts)
 *   src/data/majorCities.json  about 100 well-spread cities for weather markers
 *
 * The archive is read in memory and only ever parsed as tab-separated text.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync, unzipSync } from "fflate";
import { type CityRow, encodeCities } from "../src/geo/citiesData";
import { angularDistanceDeg } from "../src/geo/coords";

const SOURCE = "https://download.geonames.org/export/dump/cities15000.zip";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

interface City {
  name: string;
  country: string;
  lat: number;
  lon: number;
  pop: number;
  capital: boolean;
}

/** Sections of larger cities, abandoned places and the like are not useful names. */
const EXCLUDED_FEATURES = new Set(["PPLX", "PPLH", "PPLQ", "PPLW", "PPLCH"]);

const MUST_INCLUDE = [
  ["Los Angeles", "US"],
  ["San Francisco", "US"],
  ["Chicago", "US"],
  ["Washington", "US"],
  ["Toronto", "CA"],
  ["Sydney", "AU"],
  ["Dubai", "AE"],
  ["Kolkata", "IN"],
];

async function download(): Promise<City[]> {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`GeoNames download failed: HTTP ${response.status}`);
  const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
  const text = new TextDecoder().decode(files["cities15000.txt"]!);

  const cities: City[] = [];
  for (const line of text.split("\n")) {
    const cols = line.split("\t");
    if (cols.length < 15 || EXCLUDED_FEATURES.has(cols[7]!)) continue;
    cities.push({
      name: cols[1]!,
      lat: Number(cols[4]),
      lon: Number(cols[5]),
      country: cols[8]!,
      pop: Number(cols[14]),
      capital: cols[7] === "PPLC",
    });
  }
  return cities.sort((a, b) => b.pop - a.pop);
}

/**
 * The biggest cities that are not crowded together, favoring capitals, then
 * the capitals and large cities furthest from anything already chosen, so
 * remote regions also get a marker.
 */
function selectMajor(cities: City[]): City[] {
  const weight = (c: City) => c.pop * (c.capital ? 4 : 1);
  const ranked = [...cities].sort((a, b) => weight(b) - weight(a));
  // Well-known places that would otherwise lose out to a larger neighbor.
  // Several places can share a name, so take the largest match for each.
  const chosen = MUST_INCLUDE.flatMap(([name, country]) => {
    const match = ranked.find((c) => c.name === name && c.country === country);
    return match ? [match] : [];
  });
  for (const city of ranked) {
    if (chosen.length >= 72) break;
    if (chosen.every((other) => angularDistanceDeg(city, other) >= 3)) chosen.push(city);
  }

  const candidates = cities.filter(
    (c) => !chosen.includes(c) && ((c.capital && c.pop >= 50_000) || c.pop >= 500_000),
  );
  const nearest = new Map(
    candidates.map((c) => [c, Math.min(...chosen.map((o) => angularDistanceDeg(c, o)))]),
  );
  while (chosen.length < 100) {
    let best: City | null = null;
    let bestDistance = -1;
    for (const [city, distance] of nearest) {
      if (distance > bestDistance) {
        best = city;
        bestDistance = distance;
      }
    }
    if (!best) break;
    chosen.push(best);
    nearest.delete(best);
    for (const [city, distance] of nearest) {
      const d = angularDistanceDeg(city, best);
      if (d < distance) nearest.set(city, d);
    }
  }
  return chosen.sort((a, b) => b.pop - a.pop);
}

const round = (value: number) => Math.round(value * 100) / 100;

const cities = await download();
const major = selectMajor(cities);

// Rows of [name, country, lat, lon, population], largest first.
const rows: CityRow[] = cities.map((c) => [c.name, c.country, round(c.lat), round(c.lon), c.pop]);
mkdirSync(join(root, "public/data"), { recursive: true });
writeFileSync(join(root, "public/data/cities.bin"), deflateSync(encodeCities(rows), { level: 9 }));

mkdirSync(join(root, "src/data"), { recursive: true });
writeFileSync(
  join(root, "src/data/majorCities.json"),
  JSON.stringify(
    major.map((c) => ({
      name: c.name,
      country: c.country,
      lat: round(c.lat),
      lon: round(c.lon),
      pop: c.pop,
    })),
  ),
);

console.log(`${rows.length} cities, ${major.length} major:`);
console.log(major.map((c) => c.name).join(", "));
