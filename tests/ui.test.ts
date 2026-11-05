import { describe, expect, it } from "vitest";
import { backdropFor } from "../src/ui/backdrop";
import {
  compassPoint,
  formatAge,
  formatClock,
  formatDayName,
  formatLocalHour,
  formatLocalTime,
  formatTemperature,
  formatWind,
} from "../src/ui/format";
import { iconLayout, iconSrc, sunRays } from "../src/ui/icons";
import { formatHash, parseHash } from "../src/urlState";

describe("formatting", () => {
  it("converts temperatures without printing negative zero", () => {
    expect(formatTemperature(20, "c")).toBe("20°");
    expect(formatTemperature(20, "f")).toBe("68°");
    expect(formatTemperature(-0.2, "c")).toBe("0°");
    expect(formatTemperature(-40, "f")).toBe("-40°");
  });

  it("converts wind", () => {
    expect(formatWind(100, "c")).toBe("100 km/h");
    expect(formatWind(100, "f")).toBe("62 mph");
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
    ]) {
      expect(parseHash(hash)).toBeNull();
    }
    expect(parseHash("#1,2")).toEqual({ lat: 1, lon: 2 });
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

describe("forecast formatting", () => {
  it("names the nearest compass point the wind blows from", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(250)).toBe("W");
    expect(compassPoint(225)).toBe("SW");
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(-45)).toBe("NW");
  });

  it("names days relative to the place's own today", () => {
    expect(formatDayName("2026-11-04", "2026-11-04")).toBe("Today");
    expect(formatDayName("2026-11-05", "2026-11-04")).toBe("Tomorrow");
    expect(formatDayName("2026-12-01", "2026-11-30")).toBe("Tomorrow");
    expect(formatDayName("2026-11-06", "2026-11-04")).toMatch(/^Fri/);
  });
});

describe("weather backdrops", () => {
  it("match the conditions, and the time of day for clear skies", () => {
    expect(backdropFor("clear", true)).toBe("sun");
    expect(backdropFor("clear", false)).toBe("stars");
    expect(backdropFor("drizzle", true)).toBe("rain");
    expect(backdropFor("thunder", false)).toBe("storm");
    expect(backdropFor("snow", true)).toBe("snow");
  });
});

describe("icon shapes", () => {
  it("draw rain, snow and storms from the shared layout", () => {
    expect(iconLayout("rain", true).drops).toHaveLength(3);
    expect(iconLayout("drizzle", true).drops).toHaveLength(2);
    expect(iconLayout("snow", false).flakes).toBe(true);
    expect(iconLayout("thunder", true).bolt).toBe(true);
    expect(iconLayout("partly", false)).toMatchObject({ sun: null, moon: { r: 6 } });
    expect(sunRays(16, 16, 6.5)).toHaveLength(8);
  });

  it("encode every icon as an image", () => {
    for (const icon of [
      "clear",
      "partly",
      "cloudy",
      "fog",
      "drizzle",
      "rain",
      "snow",
      "thunder",
    ] as const) {
      expect(decodeURIComponent(iconSrc(icon, true))).toMatch(/<svg[^>]*>.+<\/svg>$/);
    }
  });
});
