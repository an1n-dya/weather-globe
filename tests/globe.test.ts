import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { latLonToVec3 } from "../src/geo/coords";
import { PlaceIndex } from "../src/geo/places";
import { fitDistance } from "../src/globe/camera";
import { buildEarthArrays } from "../src/globe/earthMesh";
import { buildIcosphere, FREQUENCY_HIGH, FREQUENCY_LOW, faceCount } from "../src/globe/icosphere";

describe("land data", () => {
  const grid = new Uint8Array(readFileSync("public/data/land-grid.bin"));
  const index = new PlaceIndex([["Nowhere", "AQ", -89, 0, 15000]], grid);

  it.each([
    ["United States", 40, -100],
    ["Paris", 48.85, 2.35],
    ["Antarctica", -80, 0],
    ["South Pole", -89.9, 0],
    ["Chukotka east", 66, 179],
    ["Chukotka west", 66, -175],
    ["Greenland", 72, -40],
    ["Australia", -25, 135],
    ["Sahara", 23, 10],
  ])("%s is land", (_name, lat, lon) => {
    expect(index.isLand(lat, lon)).toBe(true);
  });

  it.each([
    ["Pacific", 0, -150],
    ["Null Island", 0, 0],
    ["Atlantic", 30, -40],
    ["Arctic", 85, 0],
    ["Indian Ocean", -20, 75],
  ])("%s is water", (_name, lat, lon) => {
    expect(index.isLand(lat, lon)).toBe(false);
  });

  it.each([FREQUENCY_HIGH, FREQUENCY_LOW])(
    "mask for frequency %i matches the mesh and places land correctly",
    (frequency) => {
      const mask = new Uint8Array(readFileSync(`public/data/land-mask-${frequency}.bin`));
      const { vertices, faces } = buildIcosphere(frequency);
      expect(faces.length / 3).toBe(faceCount(frequency));
      expect(mask.length).toBe(Math.ceil(faceCount(frequency) / 8));

      const faceAt = (lat: number, lon: number) => {
        const [px, py, pz] = latLonToVec3(lat, lon);
        let best = 0;
        let bestDot = -2;
        for (let f = 0; f < faces.length / 3; f++) {
          let dot = 0;
          for (let c = 0; c < 3; c++) {
            const v = faces[f * 3 + c]! * 3;
            dot += vertices[v]! * px + vertices[v + 1]! * py + vertices[v + 2]! * pz;
          }
          if (dot > bestDot) {
            bestDot = dot;
            best = f;
          }
        }
        return (mask[best >> 3]! & (1 << (best & 7))) !== 0;
      };

      expect(faceAt(40, -100)).toBe(true);
      expect(faceAt(-25, 135)).toBe(true);
      expect(faceAt(66, 179.5)).toBe(true);
      expect(faceAt(0, -150)).toBe(false);
      expect(faceAt(30, -40)).toBe(false);
    },
  );

  it("builds an outward-facing mesh with one corner set per face", () => {
    const mask = new Uint8Array(readFileSync(`public/data/land-mask-${FREQUENCY_LOW}.bin`));
    const { positions, normals, colors } = buildEarthArrays(FREQUENCY_LOW, mask);
    const corners = faceCount(FREQUENCY_LOW) * 3;
    expect(positions.length).toBe(corners * 3);
    expect(colors.length).toBe(corners * 3);
    for (let i = 0; i < positions.length; i += 9) {
      const outward =
        positions[i]! * normals[i]! +
        positions[i + 1]! * normals[i + 1]! +
        positions[i + 2]! * normals[i + 2]!;
      expect(outward).toBeGreaterThan(0);
    }
  });
});

describe("camera fit", () => {
  it("moves further back as the free area shrinks", () => {
    expect(fitDistance(400, 800)).toBeGreaterThan(fitDistance(800, 800));
  });

  it("leaves the whole sphere inside the free area", () => {
    const distance = fitDistance(800, 800);
    const halfAngle = Math.asin(1 / distance);
    expect(Math.tan(halfAngle)).toBeLessThan(Math.tan((35 / 2) * (Math.PI / 180)));
  });
});
