/**
 * Writes public/data/regions.bin, which names any point on Earth without a
 * network call:
 *   surface    0.1° grid: open water, land, lake or ice shelf
 *   marine     0.25° grid: the sea, gulf or ocean, filled so every cell has the nearest one
 *   lakes      0.25° grid: named lakes
 *   countries  0.5° grid: the country, filled so coastal water has the nearest one
 *   regions    0.5° grid: deserts, mountain ranges, plateaus, island groups and the like
 * Sources are Natural Earth vectors (public domain). The file is deflated;
 * src/geo/regions.ts reads it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { geoArea } from "d3-geo";
import { deflateSync } from "fflate";
import type { Feature, FeatureCollection, Geometry } from "geojson";
import { feature } from "topojson-client";
import type { GeometryCollection, Topology } from "topojson-specification";
import { SURFACE } from "../src/geo/regions";
import { cachedJson, naturalEarth, root } from "./lib/download";
import { cellIndex, fillFromNearest, rasterize, rasterizeMask, rewind } from "./lib/raster";

type Props = Record<string, unknown>;
type Collection = FeatureCollection<Geometry, Props>;

const MARINE_CLASSES = new Set([
  "ocean",
  "sea",
  "bay",
  "gulf",
  "strait",
  "channel",
  "sound",
  "generic",
  "fjord",
  "lagoon",
  "inlet",
]);
const REGION_CLASSES = new Set([
  "Desert",
  "Range/mtn",
  "Plateau",
  "Basin",
  "Tundra",
  "Plain",
  "Lowland",
  "Delta",
  "Wetlands",
  "Valley",
  "Foothills",
  "Gorge",
  "Peninsula",
  "Pen/cape",
  "Island",
  "Island group",
  "Isthmus",
  "Geoarea",
]);

const englishRegion = new Intl.DisplayNames(["en"], { type: "region" });

/** "SOUTHERN OCEAN" reads better as "Southern Ocean". */
function tidy(name: string): string {
  const trimmed = name.trim();
  if (trimmed !== trimmed.toUpperCase()) return trimmed;
  return trimmed
    .toLowerCase()
    .replace(
      /(^|[\s\-(’'])(\p{L})/gu,
      (_m, lead: string, letter: string) => lead + letter.toUpperCase(),
    )
    .replace(/\b(Of|The|And|De|Del|La)\b/g, (word) => word.toLowerCase());
}

function text(props: Props, ...keys: string[]): string {
  for (const key of keys) {
    const value = props[key];
    if (typeof value === "string" && value.trim() && value !== "-99") return value;
  }
  return "";
}

function countryNameFor(props: Props): string {
  const code = text(props, "ISO_A2_EH", "ISO_A2");
  if (/^[A-Z]{2}$/.test(code)) {
    try {
      const name = englishRegion.of(code);
      if (name && name !== code) return name;
    } catch {
      // Fall through to the dataset's own name.
    }
  }
  return tidy(text(props, "NAME_EN", "NAME_LONG", "NAME"));
}

/** Larger shapes first, so smaller ones painted later win where they overlap. */
function byAreaDescending(
  features: Array<Feature<Geometry, Props>>,
): Array<Feature<Geometry, Props>> {
  return features
    .map((f) => rewind(f))
    .map((f) => ({ f, area: geoArea(f) }))
    .sort((a, b) => b.area - a.area)
    .map(({ f }) => f);
}

interface NamedGrid {
  width: number;
  height: number;
  cells: Uint16Array;
  names: string[];
}

function paintNamed(
  features: Array<Feature<Geometry, Props>>,
  width: number,
  height: number,
  nameOf: (props: Props) => string,
): NamedGrid {
  const cells = new Uint16Array(width * height);
  const names = [""];
  const ids = new Map<string, number>();
  for (const f of byAreaDescending(features)) {
    const name = nameOf(f.properties ?? {});
    if (!name) continue;
    let id = ids.get(name);
    if (id === undefined) {
      id = names.length;
      names.push(name);
      ids.set(name, id);
    }
    const value = id;
    rasterize(f, width, height, (row, from, to) => {
      cells.fill(value, row * width + from, row * width + to + 1);
    });
  }
  return { width, height, cells, names };
}

/** Spreads each lake by a cell, so lakes smaller than a cell still get their name. */
function dilate(grid: NamedGrid): void {
  const { width, height, cells } = grid;
  const source = cells.slice();
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      if (source[i] !== 0) continue;
      for (const [dx, dy] of [
        [1, 0],
        [-1, 0],
        [0, 1],
        [0, -1],
      ] as const) {
        const nx = (x + dx + width) % width;
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        const v = source[ny * width + nx]!;
        if (v !== 0) {
          cells[i] = v;
          break;
        }
      }
    }
  }
}

async function main() {
  const landTopology = JSON.parse(
    readFileSync(join(root, "node_modules/world-atlas/land-50m.json"), "utf8"),
  ) as Topology<{ land: GeometryCollection }>;
  const land = feature(landTopology, landTopology.objects.land);
  const [marine, lakes, regions, shelves, countries] = await Promise.all([
    cachedJson<Collection>(
      naturalEarth("ne_10m_geography_marine_polys"),
      "ne_10m_geography_marine_polys.geojson",
    ),
    cachedJson<Collection>(naturalEarth("ne_50m_lakes"), "ne_50m_lakes.geojson"),
    cachedJson<Collection>(
      naturalEarth("ne_50m_geography_regions_polys"),
      "ne_50m_geography_regions_polys.geojson",
    ),
    cachedJson<Collection>(
      naturalEarth("ne_50m_antarctic_ice_shelves_polys"),
      "ne_50m_antarctic_ice_shelves_polys.geojson",
    ),
    cachedJson<Collection>(
      naturalEarth("ne_50m_admin_0_countries"),
      "ne_50m_admin_0_countries.geojson",
    ),
  ]);

  // The surface, sampled at 2x2 points per cell and decided by majority.
  const SURFACE_W = 3600;
  const SURFACE_H = 1800;
  const fineW = SURFACE_W * 2;
  const fineH = SURFACE_H * 2;
  const landFine = rasterizeMask([land], fineW, fineH);
  const lakeFine = rasterizeMask(
    lakes.features.map((f) => rewind(f)),
    fineW,
    fineH,
  );
  const shelfFine = rasterizeMask(
    shelves.features.map((f) => rewind(f)),
    fineW,
    fineH,
  );
  const surface = new Uint8Array(SURFACE_W * SURFACE_H);
  for (let y = 0; y < SURFACE_H; y++) {
    for (let x = 0; x < SURFACE_W; x++) {
      let landVotes = 0;
      let lakeVotes = 0;
      let shelfVotes = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const i = (y * 2 + sy) * fineW + x * 2 + sx;
          if (lakeFine[i]) lakeVotes++;
          else if (landFine[i]) landVotes++;
          else if (shelfFine[i]) shelfVotes++;
        }
      }
      const i = y * SURFACE_W + x;
      if (landVotes >= 2) surface[i] = SURFACE.land;
      else if (lakeVotes >= 2) surface[i] = SURFACE.lake;
      else if (shelfVotes >= 2) surface[i] = SURFACE.iceShelf;
      else if (landVotes + lakeVotes + shelfVotes >= 2) {
        surface[i] = lakeVotes >= landVotes ? SURFACE.lake : SURFACE.land;
      }
    }
  }
  // Four cells to a byte.
  const surfacePacked = new Uint8Array(Math.ceil(surface.length / 4));
  surface.forEach((value, i) => {
    surfacePacked[i >> 2]! |= value << ((i & 3) * 2);
  });

  const marineGrid = paintNamed(
    marine.features.filter((f) => MARINE_CLASSES.has(String(f.properties?.featurecla))),
    1440,
    720,
    (p) => tidy(text(p, "name", "name_en")),
  );
  fillFromNearest(marineGrid.cells, marineGrid.width, marineGrid.height);

  // "name" has the familiar form (Lake Victoria rather than Nyanza), sometimes in Spanish.
  const lakeGrid = paintNamed(lakes.features, 1440, 720, (p) =>
    tidy(text(p, "name", "name_en")).replace(/^Lago (de )?/, "Lake "),
  );
  dilate(lakeGrid);

  const countryGrid = paintNamed(countries.features, 720, 360, countryNameFor);
  fillFromNearest(countryGrid.cells, countryGrid.width, countryGrid.height);

  const regionGrid = paintNamed(
    regions.features.filter((f) => REGION_CLASSES.has(String(f.properties?.FEATURECLA))),
    720,
    360,
    (p) => tidy(text(p, "NAME_EN", "NAME")),
  );

  // Spot checks: a wrong winding or projection shows up here first.
  const nameAt = (grid: NamedGrid, lat: number, lon: number) =>
    grid.names[grid.cells[cellIndex(grid.width, grid.height, lat, lon)]!];
  const surfaceAt = (lat: number, lon: number) =>
    surface[cellIndex(SURFACE_W, SURFACE_H, lat, lon)];
  const checks: Array<[string, unknown, unknown]> = [
    ["Lake Superior is a lake", surfaceAt(47.7, -87.5), SURFACE.lake],
    ["Paris is land", surfaceAt(48.85, 2.35), SURFACE.land],
    ["mid-Atlantic is open water", surfaceAt(30, -40), SURFACE.ocean],
    ["Ross Ice Shelf", surfaceAt(-81, -175), SURFACE.iceShelf],
    ["Mediterranean", nameAt(marineGrid, 35, 18), "Mediterranean Sea"],
    ["Gulf of Mexico", nameAt(marineGrid, 25, -90), "Gulf of Mexico"],
    ["Superior's name", nameAt(lakeGrid, 47.7, -87.5), "Lake Superior"],
    ["Sahara's country", nameAt(countryGrid, 23, 10), "Algeria"],
  ];
  let failed = false;
  for (const [label, actual, expected] of checks) {
    const ok = actual === expected;
    if (!ok) failed = true;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}: ${String(actual)}`);
  }
  console.log(
    `regions at Sahara: ${nameAt(regionGrid, 23, 10)}, Tibet: ${nameAt(regionGrid, 33, 88)}`,
  );
  console.log(
    `mid-Pacific: ${nameAt(marineGrid, 0, -150)}, near Hawaii: ${nameAt(marineGrid, 20, -158)}`,
  );
  if (failed) throw new Error("Region data failed a spot check");

  const sections: Array<{ key: string; bytes: Uint8Array; meta: Record<string, unknown> }> = [
    { key: "surface", bytes: surfacePacked, meta: { width: SURFACE_W, height: SURFACE_H } },
    ...(
      [
        ["marine", marineGrid],
        ["lakes", lakeGrid],
        ["countries", countryGrid],
        ["regions", regionGrid],
      ] as const
    ).map(([key, grid]) => ({
      key,
      bytes: new Uint8Array(grid.cells.buffer),
      meta: { width: grid.width, height: grid.height, names: grid.names },
    })),
  ];

  // Header JSON, then each section on a 4-byte boundary so it can be read in place.
  const layout: Record<string, Record<string, unknown>> = {};
  let offset = 0;
  for (const s of sections) {
    layout[s.key] = { ...s.meta, offset, length: s.bytes.length };
    offset += Math.ceil(s.bytes.length / 4) * 4;
  }
  const headerBytes = new TextEncoder().encode(JSON.stringify(layout));
  const headerLength = Math.ceil(headerBytes.length / 4) * 4;
  const bodyStart = 8 + headerLength;
  const file = new Uint8Array(bodyStart + offset);
  file.set(new TextEncoder().encode("WGR1"), 0);
  new DataView(file.buffer).setUint32(4, headerLength, true);
  file.set(headerBytes, 8);
  file.fill(0x20, 8 + headerBytes.length, bodyStart);
  for (const s of sections) file.set(s.bytes, bodyStart + (layout[s.key]!.offset as number));

  const packed = deflateSync(file, { level: 9 });
  writeFileSync(join(root, "public", "data", "regions.bin"), packed);
  console.log(
    `regions.bin: ${(file.length / 1024).toFixed(0)} KB raw, ${(packed.length / 1024).toFixed(0)} KB deflated; ` +
      `${marineGrid.names.length - 1} seas, ${lakeGrid.names.length - 1} lakes, ` +
      `${countryGrid.names.length - 1} countries, ${regionGrid.names.length - 1} regions`,
  );
}

await main();
