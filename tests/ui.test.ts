import { describe, expect, it } from "vitest";
import {
  formatAge,
  formatClock,
  formatLocalHour,
  formatLocalTime,
  formatTemperature,
  formatWind,
} from "../src/ui/format";
import { iconSrc } from "../src/ui/icons";
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
