import { readFileSync } from "node:fs";
import { PerspectiveCamera } from "three";
import { describe, expect, it } from "vitest";
import { latLonToVec3 } from "../src/geo/coords";
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
import { buildEarthArrays } from "../src/globe/earthMesh";
import { buildIcosphere, FREQUENCY_HIGH, FREQUENCY_LOW, faceCount } from "../src/globe/icosphere";
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
