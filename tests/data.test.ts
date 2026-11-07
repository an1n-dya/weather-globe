import { readFileSync } from "node:fs";
import { inflateSync } from "fflate";
import { describe, expect, it } from "vitest";
import { type CityRow, decodeCities, encodeCities } from "../src/geo/citiesData";

describe("cities data", () => {
  it("round-trips rows exactly, including accents, negatives and huge towns", () => {
    const rows: CityRow[] = [
      ["Tōkyō", "JP", 35.69, 139.69, 37_400_068],
      ["São Paulo", "BR", -23.55, -46.63, 12_400_232],
      ["Reykjavík", "IS", 64.15, -21.94, 118_918],
      ["Ushuaia", "AR", -54.81, -68.31, 63_000],
      ["Edge", "FJ", -16.99, 179.99, 63_000],
      ["Nowhere", "AQ", -89.99, -180, 0],
    ];
    expect(decodeCities(encodeCities(rows))).toEqual(rows);
  });

  it("rejects files that aren't cities files", () => {
    expect(() => decodeCities(new TextEncoder().encode("WGE1...."))).toThrow();
    const good = encodeCities([["A", "FR", 1, 2, 3]]);
    expect(() => decodeCities(good.subarray(0, good.length - 3))).toThrow();
  });

  it("ships every town over 15,000 people, largest first", () => {
    const rows = decodeCities(inflateSync(new Uint8Array(readFileSync("public/data/cities.bin"))));
    expect(rows.length).toBeGreaterThan(30_000);
    for (let i = 1; i < rows.length; i++) expect(rows[i]![4]).toBeLessThanOrEqual(rows[i - 1]![4]);
    const kolkata = rows.find((r) => r[0] === "Kolkata" && r[1] === "IN");
    expect(kolkata).toBeDefined();
    expect(kolkata![2]).toBeCloseTo(22.57, 1);
    expect(kolkata![3]).toBeCloseTo(88.36, 1);
  });
});
