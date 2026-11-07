import { describe, expect, it } from "vitest";
import {
  angularDistanceDeg,
  clampViewLat,
  latLonToVec3,
  lonDelta,
  normalizeLon,
  vec3ToLatLon,
} from "../src/geo/coords";
import { type CityRow, PlaceIndex, parseCityRows } from "../src/geo/places";
import { isSunUp, polarState, subsolarPoint, sunAltitudeDeg, sunDay } from "../src/geo/sun";
import {
  formatDifference,
  formatDuration,
  formatOffset,
  relativeDay,
  zoneFor,
  zoneOffsetMinutes,
} from "../src/geo/timezone";
import { realRegions } from "./helpers/regions";

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

  it("knows polar day and polar night", () => {
    const december = new Date("2026-12-21T12:00:00Z");
    expect(polarState(80, december)).toBe("night");
    expect(polarState(-80, december)).toBe("day");
    expect(polarState(60, december)).toBeNull();
    expect(polarState(0, december)).toBeNull();
    const june = new Date("2026-06-21T12:00:00Z");
    expect(polarState(70, june)).toBe("day");
    expect(polarState(-70, june)).toBe("night");
    // Just inside the Arctic Circle the sun only barely skims the horizon at midsummer.
    expect(polarState(66.6, june)).toBe("day");
  });

  it("finds the day's sunrise and sunset in local minutes", () => {
    // London on 3 November 2026: sunrise 06:57 and sunset 16:30 GMT.
    const noon = new Date("2026-11-03T12:00:00Z");
    const london = sunDay(51.51, -0.13, noon, 720);
    expect(Math.abs(london.sunrise! - (6 * 60 + 57))).toBeLessThan(3);
    expect(Math.abs(london.sunset! - (16 * 60 + 30))).toBeLessThan(3);
    expect(Math.abs(london.daylight - (london.sunset! - london.sunrise!))).toBeLessThan(3);
    expect(london.polar).toBeNull();
    const svalbard = sunDay(78.2, 15.6, new Date("2026-12-10T12:00:00Z"), 780);
    expect(svalbard).toMatchObject({ sunrise: null, sunset: null, polar: "night", daylight: 0 });
    const antarctic = sunDay(-78, 166, new Date("2026-12-10T00:00:00Z"), 780);
    expect(antarctic).toMatchObject({ polar: "day", daylight: 1440 });
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
    expect(formatDifference(330, 0)).toBe("5½ hours ahead of you");
    expect(formatDifference(0, 60)).toBe("1 hour behind you");
    expect(formatDifference(0, 120)).toBe("2 hours behind you");
    expect(formatDifference(30, 0)).toBe("30 minutes ahead of you");
    expect(formatDifference(1, 0)).toBe("1 minute ahead of you");
    // Nepal against India, and Chatham against UTC.
    expect(formatDifference(345, 330)).toBe("15 minutes ahead of you");
    expect(formatDifference(825, 0)).toBe("13¾ hours ahead of you");
    expect(formatDifference(60, 140)).toBe("1 hour 20 minutes behind you");
  });

  it("handles 45-minute and date-line offsets", () => {
    expect(zoneOffsetMinutes("Pacific/Chatham", winter)).toBe(825);
    expect(zoneOffsetMinutes("Pacific/Kiritimati", winter)).toBe(840);
    expect(zoneOffsetMinutes("Etc/GMT+12", winter)).toBe(-720);
    expect(formatOffset(zoneOffsetMinutes("Pacific/Chatham", winter))).toBe("UTC+13:45");
  });

  it("changes offset at the exact DST transition", () => {
    // US clocks spring forward at 2:00 local on 8 March 2026, which is 07:00 UTC.
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-03-08T06:59:59Z"))).toBe(-300);
    expect(zoneOffsetMinutes("America/New_York", new Date("2026-03-08T07:00:00Z"))).toBe(-240);
    // Europe falls back at 01:00 UTC on 25 October 2026.
    expect(zoneOffsetMinutes("Europe/Berlin", new Date("2026-10-25T00:59:59Z"))).toBe(120);
    expect(zoneOffsetMinutes("Europe/Berlin", new Date("2026-10-25T01:00:00Z"))).toBe(60);
  });

  it("says when the place is already on tomorrow's date, or still on yesterday's", () => {
    const lateEvening = new Date("2026-11-07T22:30:00Z");
    expect(relativeDay(lateEvening, "Pacific/Kiritimati", "UTC")).toBe("tomorrow");
    expect(relativeDay(lateEvening, "Asia/Kolkata", "UTC")).toBe("tomorrow");
    expect(relativeDay(lateEvening, "America/New_York", "UTC")).toBe("today");
    const earlyMorning = new Date("2026-11-07T03:00:00Z");
    expect(relativeDay(earlyMorning, "Pacific/Pago_Pago", "UTC")).toBe("yesterday");
    expect(relativeDay(earlyMorning, "Etc/GMT+12", "Pacific/Kiritimati")).toBe("yesterday");
  });

  it("words durations with the right number", () => {
    expect(formatDuration(60)).toBe("1 hour");
    expect(formatDuration(-90)).toBe("1½ hours");
    expect(formatDuration(45)).toBe("45 minutes");
    expect(formatDuration(0)).toBe("0 minutes");
  });
});

describe("places", () => {
  const cities: CityRow[] = [
    ["Bigtown", "IN", 22.57, 88.36, 4_500_000],
    ["Suburb", "IN", 22.6, 88.34, 20_000],
    ["Edge East", "FJ", -17, 179.9, 50_000],
    ["Genoa", "IT", 44.41, 8.93, 580_000],
  ];
  const index = new PlaceIndex(cities, realRegions());

  it("names the nearby city, favoring the larger one", () => {
    // Closer to the suburb, but the much larger city keeps the name.
    expect(index.placeAt(22.59, 88.35)).toMatchObject({
      kind: "city",
      name: "Bigtown",
      region: "India",
    });
  });

  it("says near for a city more than 25 km away", () => {
    expect(index.placeAt(23.2, 88.36)).toMatchObject({ kind: "near", name: "Near Bigtown" });
  });

  it("finds cities across the antimeridian", () => {
    expect(index.placeAt(-17, -179.9).name).toContain("Edge East");
  });

  it("names the sea or ocean instead of saying open ocean", () => {
    expect(index.placeAt(30, -40)).toMatchObject({ kind: "ocean", name: "North Atlantic Ocean" });
    expect(index.placeAt(-30, -120)).toMatchObject({ kind: "ocean", name: "South Pacific Ocean" });
    expect(index.placeAt(35, 18)).toMatchObject({ kind: "ocean", name: "Mediterranean Sea" });
    expect(index.placeAt(15, -75)).toMatchObject({ kind: "ocean", name: "Caribbean Sea" });
    expect(index.placeAt(15, 88)).toMatchObject({ kind: "ocean", name: "Bay of Bengal" });
    expect(index.placeAt(27, 51)).toMatchObject({ kind: "ocean", name: "Persian Gulf" });
    expect(index.placeAt(-60, 0).kind).toBe("ocean");
  });

  it("mentions a nearby town out at sea, but names a town's own waterfront after it", () => {
    expect(index.placeAt(43.9, 8.9)).toMatchObject({
      kind: "ocean",
      name: "Ligurian Sea",
      region: "Near Genoa, Italy",
    });
    expect(index.placeAt(44.38, 8.93)).toMatchObject({ kind: "city", name: "Genoa" });
  });

  it("names large lakes, which are water rather than land", () => {
    expect(index.placeAt(47.7, -87.5)).toMatchObject({ kind: "lake", name: "Lake Superior" });
    expect(index.placeAt(-1, 33)).toMatchObject({ kind: "lake", name: "Lake Victoria" });
    expect(index.placeAt(53.5, 108)).toMatchObject({ kind: "lake", name: "Lake Baikal" });
    expect(index.placeAt(-15.8, -69.4)).toMatchObject({ kind: "lake", name: "Lake Titicaca" });
  });

  it("names remote land by its region and country", () => {
    expect(index.placeAt(33, 88)).toMatchObject({
      kind: "remote",
      name: "Tibetan Plateau",
      region: "China",
    });
    expect(index.placeAt(-80, 0)).toMatchObject({ kind: "remote", region: "Antarctica" });
    expect(index.placeAt(-81, -175)).toMatchObject({ kind: "remote" });
  });
});

describe("place data", () => {
  it("drops damaged rows rather than showing NaN", () => {
    expect(
      parseCityRows([
        ["Ok", "FR", 1, 2, 3],
        ["Missing", "FR", 1, null, 3],
        "nonsense",
        ["Text", "FR", "1", 2, 3],
      ]),
    ).toEqual([["Ok", "FR", 1, 2, 3]]);
    expect(() => parseCityRows({})).toThrow();
  });
});
