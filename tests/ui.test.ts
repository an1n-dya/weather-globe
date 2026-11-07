import { afterEach, describe, expect, it, vi } from "vitest";
import { markerDensity } from "../src/globe/markers";
import { addToFront, loadPlaceLists, MAX_RECENTS, samePlace } from "../src/savedPlaces";
import { defaultSettings } from "../src/settings";
import { flagEmoji } from "../src/ui/flags";
import {
  compassPoint,
  compassWords,
  formatAge,
  formatClock,
  formatDayLength,
  formatDayName,
  formatLocalHour,
  formatLocalTime,
  formatPressure,
  formatTemperature,
  formatVisibility,
  formatWind,
  minutesOfDay,
  uvLevel,
} from "../src/ui/format";
import { iconSrc } from "../src/ui/icons";
import { formatMinutes, minutesInZone } from "../src/ui/time";
import { formatHash, parseHash } from "../src/urlState";

describe("formatting", () => {
  it("converts temperatures without printing negative zero", () => {
    expect(formatTemperature(20, "c")).toBe("20°");
    expect(formatTemperature(20, "f")).toBe("68°");
    expect(formatTemperature(-0.2, "c")).toBe("0°");
    expect(formatTemperature(-40, "f")).toBe("-40°");
  });

  it("converts wind to each unit", () => {
    expect(formatWind(100, "kmh")).toBe("100 km/h");
    expect(formatWind(100, "mph")).toBe("62 mph");
    expect(formatWind(36, "ms")).toBe("10 m/s");
  });

  it("names compass points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(224)).toBe("SW");
    expect(compassPoint(-45)).toBe("NW");
    expect(compassPoint(359)).toBe("N");
    expect(compassWords(90)).toBe("east");
  });

  it("formats pressure, visibility, UV and day length", () => {
    expect(formatPressure(1013.25, "c")).toBe("1013 hPa");
    expect(formatPressure(1013.25, "f")).toBe("29.92 inHg");
    expect(formatVisibility(24_140, "kmh")).toBe("24 km");
    expect(formatVisibility(800, "kmh")).toBe("0.8 km");
    expect(formatVisibility(60_000, "kmh")).toBe("Over 50 km");
    expect(formatVisibility(16_093, "mph")).toBe("10 mi");
    expect(uvLevel(0.4)).toBe("Low");
    expect(uvLevel(5.4)).toBe("Moderate");
    expect(uvLevel(7)).toBe("High");
    expect(uvLevel(11.6)).toBe("Extreme");
    expect(formatDayLength(40_000)).toBe("11 h 7 min");
    expect(formatDayLength(86_400)).toBe("24 h");
    expect(formatDayLength(1_800)).toBe("30 min");
  });

  it("names forecast days from their local dates", () => {
    expect(formatDayName("2026-11-07", 0)).toBe("Today");
    expect(formatDayName("2026-11-08", 1)).toBe("Sun");
    expect(formatDayName("2026-11-09", 2)).toBe("Mon");
    expect(minutesOfDay("2026-11-04T13:05")).toBe(785);
  });

  it("formats local wall-clock times", () => {
    expect(formatLocalTime("2026-11-04T06:05", false)).toBe("06:05");
    expect(formatLocalTime("2026-11-04T00:05", true)).toBe("12:05 AM");
    expect(formatLocalTime("2026-11-04T12:30", true)).toBe("12:30 PM");
    expect(formatLocalTime("2026-11-04T17:30", true)).toBe("5:30 PM");
    expect(formatLocalHour("2026-11-04T17:00", true)).toBe("5 PM");
    expect(formatLocalHour("2026-11-04T07:00", false)).toBe("07:00");
  });

  it("shows midnight as 00 on a 24-hour clock", () => {
    const midnight = new Date("2026-11-04T00:05:09Z");
    expect(formatClock(midnight, "UTC", false)).toContain("00:05:09");
    expect(formatClock(new Date("2026-11-04T06:05:09Z"), "UTC", false)).toContain("06:05:09");
    expect(formatClock(midnight, "UTC", true)).toMatch(/^12:05:09/);
  });

  it("formats age", () => {
    expect(formatAge(10_000)).toBe("just now");
    expect(formatAge(5 * 60_000)).toBe("5 min ago");
    expect(formatAge(2 * 3_600_000)).toBe("2 h ago");
  });
});

describe("shared links", () => {
  it("round-trips a view", () => {
    expect(parseHash(formatHash(22.5726, 88.3639, 1.8))).toEqual({
      lat: 22.57,
      lon: 88.36,
      distance: 1.8,
    });
  });

  it("rejects invalid input", () => {
    for (const hash of [
      "",
      "#",
      "#,",
      "#1,",
      "#abc",
      "#91,0",
      "#0,181",
      "#1,2,0.5",
      "#1,2,3,4",
      "#1,2,x",
      "#1e1,2",
      "#0x10,2",
      "#Infinity,2",
      "#1,2,1e400",
      "#%E0%A4%A",
      "#1,,2",
    ]) {
      expect(parseHash(hash)).toBeNull();
    }
    expect(parseHash("#1,2")).toEqual({ lat: 1, lon: 2 });
  });

  it("accepts commas that were percent-encoded on the way, and spaces", () => {
    expect(parseHash("#22.57%2C88.36%2C1.80")).toEqual({ lat: 22.57, lon: 88.36, distance: 1.8 });
    expect(parseHash("# -33.87 , 151.21 ")).toEqual({ lat: -33.87, lon: 151.21 });
    // 180 and -180 are the same meridian.
    expect(parseHash("#0,180")).toEqual({ lat: 0, lon: -180 });
  });
});

describe("icons", () => {
  it("makes images that can load in an <img> element", () => {
    const source = iconSrc("clear", true);
    expect(source.startsWith("data:image/svg+xml,")).toBe(true);
    expect(decodeURIComponent(source)).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("draws the sun by day and the moon by night", () => {
    expect(iconSrc("clear", true)).not.toBe(iconSrc("clear", false));
  });
});

describe("settings defaults", () => {
  it("follow the locale's region", () => {
    expect(defaultSettings("en-US")).toEqual({ unit: "f", hour12: true, wind: "mph" });
    expect(defaultSettings("en-GB")).toMatchObject({ unit: "c", hour12: false, wind: "mph" });
    expect(defaultSettings("de-DE")).toMatchObject({ unit: "c", hour12: false, wind: "kmh" });
    // A language alone still finds its likely region.
    expect(defaultSettings("ja")).toMatchObject({ unit: "c", wind: "kmh" });
  });
});

describe("saved places", () => {
  afterEach(() => vi.unstubAllGlobals());
  const paris = { name: "Paris", region: "France", lat: 48.85, lon: 2.35 };

  it("keeps the newest first, without duplicates, up to a limit", () => {
    let list = [paris];
    for (let i = 0; i < 12; i++) {
      list = addToFront(list, { name: `P${i}`, region: "", lat: i, lon: i }, MAX_RECENTS);
    }
    expect(list).toHaveLength(MAX_RECENTS);
    expect(list[0]?.name).toBe("P11");
    list = addToFront(list, { ...paris, lat: 48.851 }, MAX_RECENTS);
    list = addToFront(list, paris, MAX_RECENTS);
    expect(list.filter((p) => samePlace(p, paris))).toHaveLength(1);
  });

  it("survives damaged or missing storage", () => {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({ favorites: [paris, { name: "Bad", lat: 999 }], recents: "x" }),
    });
    expect(loadPlaceLists()).toEqual({ favorites: [paris], recents: [] });
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(loadPlaceLists()).toEqual({ favorites: [], recents: [] });
  });
});

describe("search rows", () => {
  it("draws flags from country codes", () => {
    expect(flagEmoji("np")).toBe("🇳🇵");
    expect(flagEmoji("GB")).toBe("🇬🇧");
    expect(flagEmoji("")).toBe("");
    expect(flagEmoji("123")).toBe("");
  });
});

describe("badge density", () => {
  it("shows fewer, more widely spaced badges when zoomed out", () => {
    const far = markerDensity(3.2);
    const near = markerDensity(1.4);
    expect(far.limit).toBeLessThan(near.limit);
    expect(far.gap).toBeGreaterThan(near.gap);
  });
});

describe("local time of day", () => {
  it("counts minutes since midnight in a zone", () => {
    const date = new Date("2026-11-07T10:30:30Z");
    expect(minutesInZone(date, "UTC")).toBeCloseTo(630.5);
    expect(minutesInZone(date, "Asia/Kathmandu")).toBeCloseTo(975.5);
    expect(minutesInZone(new Date("2026-11-07T23:59:00Z"), "UTC")).toBe(1439);
  });

  it("writes minutes as a clock time", () => {
    expect(formatMinutes(0, true)).toBe("12:00 AM");
    expect(formatMinutes(805, true)).toBe("1:25 PM");
    expect(formatMinutes(805, false)).toBe("13:25");
    expect(formatMinutes(1439.6, false)).toBe("00:00");
  });
});
