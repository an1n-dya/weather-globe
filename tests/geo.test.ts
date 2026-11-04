import { describe, expect, it } from "vitest";
import {
  angularDistanceDeg,
  clampViewLat,
  latLonToVec3,
  lonDelta,
  normalizeLon,
  vec3ToLatLon,
} from "../src/geo/coords";
import { type CityRow, PlaceIndex } from "../src/geo/places";
import { isSunUp, subsolarPoint, sunAltitudeDeg } from "../src/geo/sun";
import { formatDifference, formatOffset, zoneFor, zoneOffsetMinutes } from "../src/geo/timezone";

describe("coordinates", () => {
  it("stops the camera just short of the poles", () => {
    expect(clampViewLat(90)).toBe(89);
    expect(clampViewLat(-90)).toBe(-89);
    expect(clampViewLat(45)).toBe(45);
  });

  it("puts north up and east to the right of a viewer at lon 0", () => {
    expect(latLonToVec3(90, 0)[1]).toBeCloseTo(1);
    expect(latLonToVec3(0, 0)[2]).toBeCloseTo(1);
    expect(latLonToVec3(0, 90)[0]).toBeCloseTo(1);
  });

  it.each([
    [0, 0],
    [51.5, -0.13],
    [-33.87, 151.21],
    [35.68, 139.69],
    [21.3, -157.86],
    [10, 179.99],
    [10, -179.99],
  ])("round-trips %f, %f", (lat, lon) => {
    const [x, y, z] = latLonToVec3(lat, lon);
    const result = vec3ToLatLon(x, y, z);
    expect(result.lat).toBeCloseTo(lat, 6);
    expect(result.lon).toBeCloseTo(lon, 6);
  });

  it("is stable at the poles", () => {
    const [x, y, z] = latLonToVec3(90, 0);
    expect(vec3ToLatLon(x, y, z).lat).toBeCloseTo(90, 6);
    expect(Number.isFinite(vec3ToLatLon(0, -1, 0).lon)).toBe(true);
    expect(vec3ToLatLon(0, -1, 0).lat).toBeCloseTo(-90, 6);
  });

  it("wraps across the antimeridian", () => {
    expect(normalizeLon(190)).toBeCloseTo(-170);
    expect(normalizeLon(-190)).toBeCloseTo(170);
    expect(lonDelta(179, -179)).toBeCloseTo(2);
    expect(lonDelta(-179, 179)).toBeCloseTo(-2);
    expect(angularDistanceDeg({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeCloseTo(2);
  });
});

describe("sun position", () => {
  it.each([
    ["2026-03-20T14:46:00Z", 0],
    ["2026-06-21T08:25:00Z", 23.44],
    ["2026-09-23T00:06:00Z", 0],
    ["2026-12-21T20:50:00Z", -23.44],
  ])("declination at %s", (iso, expected) => {
    expect(subsolarPoint(new Date(iso)).lat).toBeCloseTo(expected, 0);
    expect(Math.abs(subsolarPoint(new Date(iso)).lat - expected)).toBeLessThan(0.1);
  });

  it("is over the prime meridian near 12:00 UTC when the equation of time is small", () => {
    // The equation of time is close to zero around 15 April.
    expect(Math.abs(subsolarPoint(new Date("2026-04-15T12:00:00Z")).lon)).toBeLessThan(0.5);
  });

  it("matches the equation of time in early November", () => {
    // The sun runs about 16.4 minutes ahead of the clock, about 4.1° of longitude.
    expect(subsolarPoint(new Date("2026-11-03T12:00:00Z")).lon).toBeCloseTo(-4.1, 0);
  });

  // Sunrise and sunset times reported by Open-Meteo, an independent source. At
  // these moments the sun's center sits about 0.83° below the horizon.
  const SUN_EVENTS = [
    ["Tokyo sunset", 35.68, 139.69, "2026-11-04T07:43:00Z"],
    ["Kolkata sunset", 22.57, 88.36, "2026-11-04T11:27:00Z"],
    ["Sydney sunrise", -33.87, 151.21, "2026-11-03T18:52:00Z"],
    ["London sunset", 51.51, -0.13, "2026-11-03T16:30:00Z"],
    ["Honolulu sunrise", 21.31, -157.86, "2026-11-03T16:35:00Z"],
  ] as const;

  it.each(SUN_EVENTS)("puts the terminator in the right place: %s", (_name, lat, lon, iso) => {
    expect(Math.abs(sunAltitudeDeg(lat, lon, new Date(iso)) + 0.83)).toBeLessThan(0.5);
  });

  it("agrees with the terminator on whether the sun is up", () => {
    // Well before and after the times above.
    expect(isSunUp(35.68, 139.69, new Date("2026-11-04T03:00:00Z"))).toBe(true);
    expect(isSunUp(35.68, 139.69, new Date("2026-11-04T12:00:00Z"))).toBe(false);
    expect(isSunUp(51.51, -0.13, new Date("2026-11-03T12:00:00Z"))).toBe(true);
    expect(isSunUp(51.51, -0.13, new Date("2026-11-03T22:00:00Z"))).toBe(false);
  });

  it("moves west by 15° each hour", () => {
    const a = subsolarPoint(new Date("2026-07-01T06:00:00Z")).lon;
    const b = subsolarPoint(new Date("2026-07-01T07:00:00Z")).lon;
    expect(lonDelta(a, b)).toBeCloseTo(-15, 0);
  });
});

describe("time zones", () => {
  const winter = new Date("2026-01-15T12:00:00Z");
  const summer = new Date("2026-07-15T12:00:00Z");

  it("applies DST", () => {
    expect(zoneOffsetMinutes("America/New_York", winter)).toBe(-300);
    expect(zoneOffsetMinutes("America/New_York", summer)).toBe(-240);
    expect(zoneOffsetMinutes("Australia/Sydney", winter)).toBe(660);
    expect(zoneOffsetMinutes("Australia/Sydney", summer)).toBe(600);
  });

  it("handles fractional offsets", () => {
    expect(zoneOffsetMinutes("Asia/Kolkata", winter)).toBe(330);
    expect(zoneOffsetMinutes("Asia/Kathmandu", winter)).toBe(345);
  });

  it("shows the correct sign for inverted Etc zones", () => {
    expect(zoneOffsetMinutes("Etc/GMT+10", winter)).toBe(-600);
    expect(formatOffset(zoneOffsetMinutes("Etc/GMT+10", winter))).toBe("UTC−10");
    expect(zoneOffsetMinutes("Etc/GMT-5", winter)).toBe(300);
    expect(formatOffset(zoneOffsetMinutes("Etc/GMT-5", winter))).toBe("UTC+5");
  });

  it("derives open-water zones from longitude with the correct sign", () => {
    const atSea = (lon: number) => zoneFor(0, lon, true);
    expect(formatOffset(zoneOffsetMinutes(atSea(-150), winter))).toBe("UTC−10");
    expect(formatOffset(zoneOffsetMinutes(atSea(75), winter))).toBe("UTC+5");
    expect(atSea(0)).toBe("Etc/GMT");
    expect(atSea(Number.NaN)).toBe("Etc/GMT");
    expect(formatOffset(zoneOffsetMinutes(atSea(179.9), winter))).toBe("UTC+12");
  });

  it("prefers the zone reported with the weather, unless the browser does not know it", () => {
    expect(zoneFor(35.68, 139.69, false, "Asia/Kolkata")).toBe("Asia/Kolkata");
    expect(zoneFor(35.68, 139.69, false, "Not/AZone")).toBe("Asia/Tokyo");
    expect(zoneFor(35.68, 139.69, false)).toBe("Asia/Tokyo");
  });

  it("formats offsets and differences", () => {
    expect(formatOffset(0)).toBe("UTC");
    expect(formatOffset(330)).toBe("UTC+5:30");
    expect(formatOffset(-210)).toBe("UTC−3:30");
    expect(formatDifference(330, 330)).toBe("Same time as you");
    expect(formatDifference(330, 0)).toBe("5h 30m ahead of you");
    expect(formatDifference(0, 60)).toBe("1h behind you");
    expect(formatDifference(30, 0)).toBe("30m ahead of you");
  });
});

describe("places", () => {
  const cities: CityRow[] = [
    ["Bigtown", "IN", 22.57, 88.36, 4_500_000],
    ["Suburb", "IN", 22.6, 88.34, 20_000],
    ["Edge East", "FJ", -17, 179.9, 50_000],
  ];
  const landOnlyAt = (lat: number, lon: number) => {
    const grid = new Uint8Array(32400);
    const bit = Math.floor((90 - lat) * 2) * 720 + Math.floor((lon + 180) * 2);
    grid[bit >> 3]! |= 1 << (bit & 7);
    return grid;
  };

  it("names the nearby city, favoring the larger one", () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    // Closer to the suburb, but the much larger city keeps the name.
    expect(index.placeAt(22.59, 88.35)).toMatchObject({
      kind: "city",
      name: "Bigtown",
      region: "India",
    });
  });

  it("says near for a city more than 25 km away", () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    expect(index.placeAt(23.2, 88.36)).toMatchObject({ kind: "near", name: "Near Bigtown" });
  });

  it("finds cities across the antimeridian", () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    expect(index.placeAt(-17, -179.9).name).toContain("Edge East");
  });

  it("falls back to ocean or remote land", () => {
    expect(new PlaceIndex(cities, new Uint8Array(32400)).placeAt(0, -150)).toMatchObject({
      kind: "ocean",
      name: "Open ocean",
    });
    expect(new PlaceIndex(cities, landOnlyAt(70, 100)).placeAt(69.9, 100.1)).toMatchObject({
      kind: "remote",
      name: "Remote area",
    });
  });
});
