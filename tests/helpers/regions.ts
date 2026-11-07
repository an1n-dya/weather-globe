import { readFileSync } from "node:fs";
import { inflateSync } from "fflate";
import { Regions } from "../../src/geo/regions";

let cached: Regions | null = null;

/** The real offline region data, as the app loads it. */
export function realRegions(): Regions {
  cached ??= new Regions(inflateSync(new Uint8Array(readFileSync("public/data/regions.bin"))));
  return cached;
}
