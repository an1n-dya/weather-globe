import { readFileSync } from "node:fs";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { PlaceIndex } from "../src/geo/places";
import { dampingFor, fitDistance } from "../src/globe/camera";
import { frameInterval, type PaceState } from "../src/globe/pacing";
import { starColor } from "../src/globe/stars";
import { sunClearance } from "../src/globe/sunGlare";
import { dayTextureFile } from "../src/globe/textures";

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

describe("textures", () => {
  it("shows this month's imagery, by the UTC calendar", () => {
    expect(dayTextureFile(new Date("2026-11-04T12:00:00Z"), "4k")).toBe("day-11-4k.webp");
    expect(dayTextureFile(new Date("2026-01-01T00:30:00Z"), "2k")).toBe("day-01-2k.webp");
  });

  it("has a file for every month in both sizes", () => {
    for (let month = 1; month <= 12; month++) {
      for (const size of ["4k", "2k"]) {
        const file = `public/textures/day-${String(month).padStart(2, "0")}-${size}.webp`;
        expect(readFileSync(file).subarray(8, 12).toString()).toBe("WEBP");
      }
    }
  });
});

describe("stars", () => {
  it("colors hot stars blue and cool stars orange", () => {
    const [hotRed, , hotBlue] = starColor(-0.3);
    const [coolRed, , coolBlue] = starColor(1.6);
    expect(hotBlue).toBeGreaterThan(hotRed);
    expect(coolRed).toBeGreaterThan(coolBlue);
  });

  it("stores the brightest stars first, with sensible positions", () => {
    const bytes = readFileSync("public/data/stars.bin");
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(bytes.length % 8).toBe(0);
    expect(bytes.length / 8).toBeGreaterThan(9000);
    // Sirius: right ascension 101.29°, declination -16.72°, magnitude -1.46.
    expect((view.getUint16(0, true) / 65536) * 360).toBeCloseTo(101.29, 1);
    expect((view.getInt16(2, true) / 32767) * 90).toBeCloseTo(-16.72, 1);
    expect(view.getInt16(4, true) / 100).toBeCloseTo(-1.46, 2);
    let previous = Number.NEGATIVE_INFINITY;
    for (let i = 0; i < bytes.length / 8; i += 97) {
      const magnitude = view.getInt16(i * 8 + 4, true);
      expect(magnitude).toBeGreaterThanOrEqual(previous);
      previous = magnitude;
    }
  });
});

describe("sun glare", () => {
  const sun = new Vector3(0, 0, -1);

  it("hides the sun behind the planet and shows it past the limb", () => {
    // Straight behind the planet, then just past its edge, seen from 3 radii out.
    expect(sunClearance(new Vector3(0, 0, 3), sun).visible).toBe(0);
    const past = sunClearance(new Vector3(0, 3 * Math.sin(0.37), 3 * Math.cos(0.37)), sun);
    expect(past.visible).toBe(1);
    expect(past.clearance).toBeGreaterThan(0.05);
  });

  it("ignores a sun behind the camera, out of view", () => {
    expect(sunClearance(new Vector3(0, 0, -3), sun).visible).toBe(0);
  });
});

describe("frame pacing", () => {
  const calm: PaceState = {
    motion: true,
    software: false,
    idle: false,
    busy: false,
    falling: false,
  };

  it("draws every frame while the globe moves, and drifts cloud at 30 fps", () => {
    expect(frameInterval({ ...calm, busy: true })).toBe(0);
    expect(frameInterval(calm)).toBeCloseTo(1000 / 30);
    expect(frameInterval({ ...calm, falling: true })).toBe(0);
  });

  it("slows down once idle, keeping falling rain smooth enough", () => {
    expect(frameInterval({ ...calm, idle: true })).toBe(100);
    expect(frameInterval({ ...calm, idle: true, falling: true })).toBe(50);
  });

  it("draws only on change when motion is reduced", () => {
    expect(frameInterval({ ...calm, motion: false, busy: true })).toBe(Number.POSITIVE_INFINITY);
  });

  it("spares a CPU doing the drawing, except while the user moves the globe", () => {
    expect(frameInterval({ ...calm, software: true })).toBe(125);
    expect(frameInterval({ ...calm, software: true, busy: true })).toBe(0);
  });
});

describe("camera damping", () => {
  it("glides for the same time at any frame rate", () => {
    const remaining = (fps: number) => (1 - dampingFor(1 / fps)) ** fps;
    expect(dampingFor(1 / 60)).toBeCloseTo(0.08);
    expect(remaining(30)).toBeCloseTo(remaining(60), 6);
    expect(remaining(120)).toBeCloseTo(remaining(60), 6);
  });
});
