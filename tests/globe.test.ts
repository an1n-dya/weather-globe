import { readFileSync } from "node:fs";
import { deflateSync, inflateSync } from "fflate";
import { PerspectiveCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import { latLonToVec3, vec3ToLatLon } from "../src/geo/coords";
import {
  decay,
  degreesPerPixel,
  FOV,
  fitDistance,
  GlobeCameraRig,
  MIN_DISTANCE,
  scaledDistance,
  wheelZoomFactor,
} from "../src/globe/camera";
import {
  decodeEarth,
  decodeOctahedral,
  EarthDecoder,
  type EarthHeader,
  encodeEarth,
  encodeOctahedral,
} from "../src/globe/earthData";
import {
  buildEarthArrays,
  type EarthArrays,
  seasonPosition,
  triangulateSphere,
} from "../src/globe/earthMesh";
import { createInflater } from "../src/inflate";
import { realRegions } from "./helpers/regions";

describe("land data", () => {
  const index = realRegions();

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
    ["Lake Superior", 47.7, -87.5],
    ["Caspian Sea", 42, 50.5],
  ])("%s is water", (_name, lat, lon) => {
    expect(index.isLand(lat, lon)).toBe(false);
  });
});

describe("earth file", () => {
  // A small file: three levels of 4, 3 and 5 points.
  const header: EarthHeader = {
    count: 12,
    levels: [4, 7, 12],
    tiers: { low: 4, medium: 7, high: 12 },
  };
  const octahedral = new Uint16Array(24).map((_, i) => (i * 40_503 + 11) % 65_536);
  const values = new Uint8Array(12).map((_, i) => i * 20);
  const infos = new Uint8Array(12).map((_, i) => (i % 4) | ((i % 13) << 2));
  const seasons = new Uint16Array(12).map((_, i) => (i * 1_237) & 0xfff);
  const file = encodeEarth(header, { octahedral, values, infos, seasons });

  it("reads back what was written", () => {
    const points = decodeEarth(file);
    expect(points.header).toEqual(header);
    for (let i = 0; i < 12; i++) {
      const [x, y, z] = decodeOctahedral(octahedral[i * 2]!, octahedral[i * 2 + 1]!);
      expect([...points.positions.subarray(i * 3, i * 3 + 3)]).toEqual([x, y, z]);
      expect(points.values[i]).toBe(values[i]);
      expect(points.kinds[i]).toBe(infos[i]! & 3);
      expect(points.biomes[i]).toBe(infos[i]! >> 2);
      expect(points.seasons[i]).toBe(seasons[i]);
    }
  });

  it("decodes each level as soon as it has arrived", () => {
    const decoder = new EarthDecoder();
    const ready: number[] = [];
    for (let i = 0; i < file.length; i++) {
      decoder.push(file.subarray(i, i + 1));
      if (ready.at(-1) !== decoder.decoded) ready.push(decoder.decoded);
    }
    expect(ready).toEqual([0, 4, 7, 12]);
    expect(decoder.finish().values).toEqual(decodeEarth(file).values);
  });

  it("refuses a file that is cut short, damaged or not an earth file", () => {
    const short = new EarthDecoder();
    short.push(file.subarray(0, file.length - 1));
    expect(short.decoded).toBe(7);
    expect(() => short.finish()).toThrow(/truncated/);
    expect(() => decodeEarth(new TextEncoder().encode("WGE1 an older file"))).toThrow(
      /Not an earth file/,
    );
    const damaged = encodeEarth(
      { ...header, levels: [4, 12, 7] },
      { octahedral, values, infos, seasons },
    );
    expect(() => decodeEarth(damaged)).toThrow(/damaged header/);
  });

  it("inflates a stream piece by piece, and reports damage at the end", async () => {
    const compressed = deflateSync(file, { level: 9 });
    const out: Uint8Array[] = [];
    const inflater = await createInflater((chunk) => out.push(chunk.slice()));
    for (let i = 0; i < compressed.length; i += 7) inflater.push(compressed.slice(i, i + 7));
    await inflater.end();
    const joined = new Uint8Array(out.reduce((n, c) => n + c.length, 0));
    let offset = 0;
    for (const chunk of out) {
      joined.set(chunk, offset);
      offset += chunk.length;
    }
    expect(joined).toEqual(file);

    const broken = await createInflater(() => {});
    broken.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x12]));
    await expect(broken.end()).rejects.toThrow();
  });

  it("inflates a stream with fflate where the browser can't", async () => {
    vi.stubGlobal("DecompressionStream", undefined);
    try {
      const compressed = deflateSync(file, { level: 9 });
      let length = 0;
      const inflater = await createInflater((chunk) => {
        length += chunk.length;
      });
      for (let i = 0; i < compressed.length; i += 5) inflater.push(compressed.slice(i, i + 5));
      await inflater.end();
      expect(length).toBe(file.length);
      const broken = await createInflater(() => {});
      broken.push(new Uint8Array([0xff, 0xff, 0xff, 0xff, 0x00, 0x12]));
      await expect(broken.end()).rejects.toThrow();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("globe mesh", () => {
  const points = decodeEarth(inflateSync(new Uint8Array(readFileSync("public/data/earth.bin"))));
  const { tiers, levels, count } = points.header;

  it("orders the points coarse to fine, with three detail tiers", () => {
    expect(levels.at(-1)).toBe(count);
    for (let i = 1; i < levels.length; i++) expect(levels[i]!).toBeGreaterThan(levels[i - 1]!);
    expect(tiers.low).toBeLessThan(tiers.medium);
    expect(tiers.medium).toBeLessThan(tiers.high);
    expect(tiers.high).toBe(count);
    // The light tier stays light, and full detail stays well within a phone's means.
    expect(tiers.low * 2).toBeLessThan(40_000);
    expect(count * 2).toBeLessThan(260_000);
  });

  it("round-trips positions through the octahedral code to within half a kilometer", () => {
    for (const [lat, lon] of [
      [0, 0],
      [89.9, 10],
      [-89.9, -170],
      [12.3, 179.99],
      [-45, -0.01],
    ] as const) {
      const [x, y, z] = latLonToVec3(lat, lon);
      const [u, v] = encodeOctahedral(x, y, z);
      const [dx, dy, dz] = decodeOctahedral(u, v);
      const km = Math.acos(Math.min(1, x * dx + y * dy + z * dz)) * 6371;
      expect(km).toBeLessThan(0.5);
    }
  });

  it.each(["low", "medium"] as const)(
    "triangulates the %s tier into a closed surface, every face wound outward",
    (tier) => {
      const n = tiers[tier];
      const faces = triangulateSphere(points.positions, n);
      // A triangulated sphere has 2n - 4 faces.
      expect(faces.length / 3).toBe(2 * n - 4);
      // Each edge is used once in each direction: no cracks, no flipped faces.
      const edges = new Set<number>();
      for (let f = 0; f < faces.length; f += 3) {
        for (let e = 0; e < 3; e++) {
          const a = faces[f + e]!;
          const b = faces[f + ((e + 1) % 3)]!;
          const key = a * n + b;
          expect(edges.has(key)).toBe(false);
          edges.add(key);
        }
      }
      for (const key of edges) {
        const a = Math.floor(key / n);
        const b = key % n;
        expect(edges.has(b * n + a)).toBe(true);
      }
    },
  );

  describe("at full detail", () => {
    // Midsummer in the north, when the lakes are open.
    const { positions, colors } = buildEarthArrays(
      points,
      tiers.high,
      new Date("2026-07-15T12:00:00Z"),
    );
    const faceTotal = positions.length / 9;

    /** The gloss of the face the point falls in: 0 is land, 255 the sea. */
    const glossAt = (lat: number, lon: number): number => {
      const [px, py, pz] = latLonToVec3(lat, lon);
      for (let f = 0; f < faceTotal; f++) {
        const o = f * 9;
        let inside = true;
        for (let e = 0; e < 3 && inside; e++) {
          const a = o + e * 3;
          const b = o + ((e + 1) % 3) * 3;
          // The point must be on the inner side of the plane through each edge and the center.
          const cx = positions[a + 1]! * positions[b + 2]! - positions[a + 2]! * positions[b + 1]!;
          const cy = positions[a + 2]! * positions[b]! - positions[a]! * positions[b + 2]!;
          const cz = positions[a]! * positions[b + 1]! - positions[a + 1]! * positions[b]!;
          inside = cx * px + cy * py + cz * pz >= 0;
        }
        if (inside) return colors[f * 12 + 3]!;
      }
      throw new Error(`No face at ${lat}, ${lon}`);
    };

    it("faces outward everywhere", () => {
      for (let o = 0; o < positions.length; o += 9) {
        const ux = positions[o + 3]! - positions[o]!;
        const uy = positions[o + 4]! - positions[o + 1]!;
        const uz = positions[o + 5]! - positions[o + 2]!;
        const vx = positions[o + 6]! - positions[o]!;
        const vy = positions[o + 7]! - positions[o + 1]!;
        const vz = positions[o + 8]! - positions[o + 2]!;
        const outward =
          (uy * vz - uz * vy) * positions[o]! +
          (uz * vx - ux * vz) * positions[o + 1]! +
          (ux * vy - uy * vx) * positions[o + 2]!;
        expect(outward).toBeGreaterThan(0);
      }
    });

    it.each([
      ["the Great Plains", 40, -100],
      ["central Australia", -25, 135],
      ["Italy's toe", 38.9, 16.4],
      ["Italy's heel", 40.4, 18],
      ["Sicily", 37.5, 14.2],
      ["Ireland", 53.2, -8],
      ["England", 52.5, -1.5],
      ["Honshu", 36.2, 138.2],
      ["Florida", 28, -81.5],
      ["Baja California", 27, -113],
      ["Madagascar", -19, 46.7],
      ["New Zealand's North Island", -38.5, 176],
      ["Borneo", 0.5, 114],
      ["Cuba", 22, -79.5],
      ["Sri Lanka", 7.8, 80.7],
    ])("%s is land", (_name, lat, lon) => {
      expect(glossAt(lat, lon)).toBeLessThan(100);
    });

    it.each([
      ["the open Pacific", 0, -150],
      ["the mid-Atlantic", 30, -40],
      ["the Red Sea", 20, 38.5],
      ["the Persian Gulf", 27, 51],
      ["the Adriatic", 43, 15.5],
      ["the Gulf of California", 27.8, -111.3],
      ["the Caribbean", 15, -75],
      ["the Sea of Japan", 40, 135],
      ["the Irish Sea", 53.8, -5],
      ["Lake Superior", 47.7, -87.5],
      ["Lake Michigan", 43.8, -87],
      ["Lake Victoria", -1, 33],
    ])("%s is water", (_name, lat, lon) => {
      expect(glossAt(lat, lon)).toBeGreaterThan(150);
    });
  });
});

describe("seasons", () => {
  const points = decodeEarth(inflateSync(new Uint8Array(readFileSync("public/data/earth.bin"))));
  const at = (date: string) => buildEarthArrays(points, points.header.tiers.medium, new Date(date));
  const january = at("2026-01-15T12:00:00Z");
  const february = at("2026-02-15T12:00:00Z");
  const july = at("2026-07-15T12:00:00Z");
  const august = at("2026-08-15T12:00:00Z");
  const september = at("2026-09-15T12:00:00Z");
  /**
   * Gloss marks what a face is: 90 for ice on lakes and seas, 220 and 255 for
   * open water, 60 for the season's snow, 70 for lasting snow, 0 for bare land.
   */
  const ICE = 90;
  const SNOW = 60;
  const WATER = [ICE, 220, 255];
  const LAND = [SNOW, 70, 0];

  /** Among the faces of one kind centered in a box of latitude and longitude, the share with a gloss. */
  const share = (
    { positions, colors }: EarthArrays,
    box: number[],
    gloss: number,
    among: number[],
  ): number => {
    const [south = 0, north = 0, west = 0, east = 0] = box;
    let inBox = 0;
    let matching = 0;
    for (let f = 0; f < positions.length / 9; f++) {
      const o = f * 9;
      const x = positions[o]! + positions[o + 3]! + positions[o + 6]!;
      const y = positions[o + 1]! + positions[o + 4]! + positions[o + 7]!;
      const z = positions[o + 2]! + positions[o + 5]! + positions[o + 8]!;
      const { lat, lon } = vec3ToLatLon(x, y, z);
      const faceGloss = colors[f * 12 + 3]!;
      if (lat < south || lat > north || lon < west || lon > east) continue;
      if (!among.includes(faceGloss)) continue;
      inBox++;
      if (faceGloss === gloss) matching++;
    }
    expect(inBox).toBeGreaterThan(20);
    return matching / inBox;
  };

  it("freezes Hudson Bay in winter and opens it in summer", () => {
    const bay = [56, 63, -93, -79];
    expect(share(february, bay, ICE, WATER)).toBeGreaterThan(0.9);
    expect(share(august, bay, ICE, WATER)).toBeLessThan(0.05);
  });

  it("rings Antarctica with sea ice in September, not in February", () => {
    // In the recent low years the ice reached past 60° south mostly in the Weddell and Indian sectors.
    const ring = [-66, -60, -180, 180];
    expect(share(september, ring, ICE, WATER)).toBeGreaterThan(0.55);
    expect(share(february, ring, ICE, WATER)).toBeLessThan(0.15);
  });

  it("keeps the middle of the Arctic Ocean frozen, even at the end of summer", () => {
    expect(share(september, [82, 90, -180, 180], ICE, WATER)).toBeGreaterThan(0.9);
  });

  it("covers Siberia with snow in January, and not in July", () => {
    const siberia = [55, 65, 60, 120];
    expect(share(january, siberia, SNOW, LAND)).toBeGreaterThan(0.7);
    expect(share(july, siberia, SNOW, LAND)).toBeLessThan(0.02);
  });

  it("keeps the Sahara free of snow all year", () => {
    const sahara = [18, 28, -5, 25];
    expect(share(january, sahara, SNOW, LAND)).toBe(0);
    expect(share(july, sahara, SNOW, LAND)).toBe(0);
  });

  it("measures the season from the middle of each month", () => {
    // Mid-January is all January; mid-July all July; the turn of a month halfway between.
    expect(seasonPosition(new Date("2026-01-16T12:00:00Z")) % 12).toBeLessThan(0.05);
    expect(seasonPosition(new Date("2026-07-16T12:00:00Z"))).toBeCloseTo(6, 1);
    expect(seasonPosition(new Date("2026-07-01T00:00:00Z"))).toBeCloseTo(5.46, 1);
    expect(seasonPosition(new Date("2026-12-31T23:59:59Z"))).toBeCloseTo(11.5, 1);
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

/** Just enough of an element for the rig: listeners, a size and pointer capture. */
function fakeCanvas() {
  const listeners = new Map<string, (event: unknown) => void>();
  const element = {
    clientHeight: 800,
    addEventListener: (type: string, listener: (event: unknown) => void) =>
      listeners.set(type, listener),
    removeEventListener: (type: string) => listeners.delete(type),
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture: () => {},
  };
  const fire = (type: string, init: Record<string, unknown>) =>
    listeners.get(type)?.({ pointerType: "mouse", button: 0, pointerId: 1, ...init });
  return { element: element as unknown as HTMLElement, fire };
}

/** Drags quickly, lets go, then runs frames at a given rate until the glide stops. */
function fling(fps: number) {
  const camera = new PerspectiveCamera(FOV, 1.5, 0.02, 60);
  const { element, fire } = fakeCanvas();
  const rig = new GlobeCameraRig(camera, element, false, {
    wake: () => {},
    tap: () => {},
    doubleTap: () => {},
  });
  rig.setMaxDistance(4);
  rig.jumpTo({ lat: 10, lon: 20, distance: 3 });
  fire("pointerdown", { clientX: 100, clientY: 400, timeStamp: 0 });
  for (let i = 1; i <= 6; i++) {
    fire("pointermove", { clientX: 100 + i * 30, clientY: 400, timeStamp: i * 16 });
  }
  fire("pointerup", { clientX: 280, clientY: 400, timeStamp: 100 });
  const step = 1000 / fps;
  let now = 100;
  while (rig.update(now) && now < 10_000) now += step;
  return { stoppedAfterMs: now - 100, view: rig.view };
}

describe("camera rig", () => {
  it("glides for the same time and distance at any frame rate", () => {
    const slow = fling(20);
    const fast = fling(120);
    expect(slow.stoppedAfterMs).toBeLessThan(2500);
    expect(Math.abs(slow.stoppedAfterMs - fast.stoppedAfterMs)).toBeLessThan(120);
    expect(Math.abs(slow.view.lon - fast.view.lon)).toBeLessThan(1);
    // Dragging right turns the globe so places to the west come into view.
    expect(fast.view.lon).toBeLessThan(20);
  });

  it("decays the same in many small steps as in one big one", () => {
    let many = 100;
    for (let i = 0; i < 6; i++) many = decay(many, 0.1 / 6, 0.3);
    expect(many).toBeCloseTo(decay(100, 0.1, 0.3), 9);
  });

  it("zooms evenly and within limits", () => {
    expect(scaledDistance(3, 0.5, MIN_DISTANCE, 4)).toBeCloseTo(2);
    expect(scaledDistance(1.2, 0.01, MIN_DISTANCE, 4)).toBe(MIN_DISTANCE);
    expect(scaledDistance(3, 10, MIN_DISTANCE, 4)).toBe(4);
    expect(wheelZoomFactor(100, 0, false)).toBeGreaterThan(1);
    expect(wheelZoomFactor(-100, 0, false)).toBeLessThan(1);
    // A line-mode wheel step and a huge burst are both kept to a sane amount.
    expect(wheelZoomFactor(3, 1, false)).toBeGreaterThan(1.05);
    expect(wheelZoomFactor(100_000, 0, false)).toBeLessThan(2);
  });

  it("turns slower as the camera comes closer", () => {
    expect(degreesPerPixel(1.2, 800)).toBeLessThan(degreesPerPixel(3, 800));
    expect(degreesPerPixel(1, 800)).toBe(0);
  });
});
