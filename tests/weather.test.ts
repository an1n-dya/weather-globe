import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import majorCities from "../src/data/majorCities.json";
import { latLonToVec3 } from "../src/geo/coords";
import { snapToCell, TtlCache } from "../src/weather/cache";
import { skyFor } from "../src/weather/conditions";
import {
  buildSkyField,
  climateCloud,
  FIELD_HEIGHT,
  FIELD_WIDTH,
  sampleSkyField,
} from "../src/weather/field";
import { ForecastLoader, type ForecastState } from "../src/weather/forecastLoader";
import { type Forecast, fetchCurrentBatch, parseForecast } from "../src/weather/provider";
import { skyPoints } from "../src/weather/skyPoints";
import { startSkyWeather } from "../src/weather/skyWeather";
import { describeWeatherCode, WMO_CODES } from "../src/weather/wmo";

describe("weather codes", () => {
  it("maps every documented code to a labeled condition", () => {
    const documented = [
      0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85,
      86, 95, 96, 99,
    ];
    expect(
      Object.keys(WMO_CODES)
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual(documented);
    for (const code of documented) {
      expect(describeWeatherCode(code).label).not.toBe("Unknown");
    }
  });

  it("has a safe fallback", () => {
    expect(describeWeatherCode(1234)).toEqual({ label: "Unknown", icon: "cloudy" });
  });
});

describe("cache", () => {
  it("expires by time but keeps stale values readable", () => {
    let now = 0;
    const cache = new TtlCache<string>(100, 10, () => now);
    cache.set("a", "value");
    expect(cache.isFresh(cache.get("a")!)).toBe(true);
    now = 100;
    expect(cache.isFresh(cache.get("a")!)).toBe(false);
    expect(cache.get("a")!.value).toBe("value");
  });

  it("evicts the least recently used entry", () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.get("a");
    cache.set("c", 3);
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("snaps to 0.25° cells and wraps at the antimeridian", () => {
    expect(snapToCell(22.57, 88.36)).toMatchObject({ lat: 22.5, lon: 88.25, key: "22.5,88.25" });
    expect(snapToCell(10, 179.99).key).toBe(snapToCell(10, -179.99).key);
  });
});

const forecastNamed = (timezone: string): Forecast => ({
  timezone,
  current: {
    time: "2026-11-04T12:00",
    temp: 20,
    feelsLike: 19,
    humidity: 50,
    wind: 10,
    windDirection: null,
    code: 0,
    isDay: true,
    cloudCover: null,
    precipitation: null,
  },
  hourly: [],
  daily: [],
  sunrise: null,
  sunset: null,
});

function deferredFetcher() {
  const calls: Array<{
    lat: number;
    lon: number;
    signal: AbortSignal;
    resolve: (forecast: Forecast) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetcher = (lat: number, lon: number, signal: AbortSignal) =>
    new Promise<Forecast>((resolve, reject) => {
      calls.push({ lat, lon, signal, resolve, reject });
    });
  return { calls, fetcher };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("forecast loader", () => {
  it("never lets a superseded response overwrite a newer one", async () => {
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s));

    loader.select(10, 10);
    loader.select(20, 20);
    expect(calls[0]!.signal.aborted).toBe(true);
    expect(calls[1]!.signal.aborted).toBe(false);

    calls[1]!.resolve(forecastNamed("new"));
    await settle();
    // The old request ignored its abort and answers late.
    calls[0]!.resolve(forecastNamed("old"));
    await settle();

    const last = states.at(-1)!;
    expect(last.key).toBe("20,20");
    expect(last.data?.timezone).toBe("new");
  });

  it("ignores errors from aborted requests", async () => {
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s));
    loader.select(10, 10);
    loader.select(20, 20);
    calls[0]!.reject(new Error("aborted"));
    await settle();
    expect(states.some((s) => s.status === "error")).toBe(false);
  });

  it("serves fresh data from cache without a request, then refetches after 15 minutes", async () => {
    let now = 1_000;
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s), { now: () => now });

    loader.select(10, 10);
    calls[0]!.resolve(forecastNamed("a"));
    await settle();
    loader.select(20, 20);
    calls[1]!.resolve(forecastNamed("b"));
    await settle();

    loader.select(10, 10);
    expect(calls.length).toBe(2);
    expect(states.at(-1)).toMatchObject({ status: "ready", key: "10,10" });

    now += 15 * 60_000;
    loader.refreshIfExpired();
    expect(calls.length).toBe(3);
    // The old value stays on screen while refreshing.
    expect(states.at(-1)).toMatchObject({ status: "loading" });
    expect(states.at(-1)?.data?.timezone).toBe("a");
  });

  it("keeps stale data on failure and backs off exponentially", async () => {
    let now = 0;
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s), {
      now: () => now,
      setTimer: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });

    loader.select(10, 10);
    calls[0]!.resolve(forecastNamed("a"));
    await settle();

    now += 15 * 60_000;
    loader.refreshIfExpired();
    calls[1]!.reject(new Error("HTTP 429"));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: "error" });
    expect(states.at(-1)?.data?.timezone).toBe("a");
    expect(timers[0]!.ms).toBe(5_000);

    timers[0]!.callback();
    calls[2]!.reject(new Error("HTTP 429"));
    await settle();
    expect(timers[1]!.ms).toBe(10_000);

    timers[1]!.callback();
    calls[3]!.resolve(forecastNamed("b"));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: "ready" });
    expect(states.at(-1)?.data?.timezone).toBe("b");
  });

  it("ignores a request that answers after moving to an already-cached place", async () => {
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s));

    loader.select(20, 20);
    calls[0]!.resolve(forecastNamed("cached"));
    await settle();

    loader.select(10, 10);
    loader.select(20, 20);
    expect(calls.length).toBe(2);
    expect(states.at(-1)?.key).toBe("20,20");

    // The request for 10,10 ignored its abort and answers late.
    calls[1]!.resolve(forecastNamed("late"));
    await settle();
    expect(states.at(-1)?.key).toBe("20,20");
    expect(states.at(-1)?.data?.timezone).toBe("cached");
  });

  it("does not refetch while a request for the same cell is running", () => {
    const { calls, fetcher } = deferredFetcher();
    const loader = new ForecastLoader(fetcher, () => {});
    loader.select(10, 10);
    loader.select(10.01, 10.01);
    expect(calls.length).toBe(1);
  });
});

describe("forecast parsing", () => {
  const raw = {
    timezone: "Asia/Kolkata",
    current: {
      time: "2026-11-04T13:15",
      temperature_2m: 30.2,
      apparent_temperature: 33,
      relative_humidity_2m: 60,
      wind_speed_10m: 8,
      weather_code: 2,
      is_day: 1,
    },
    hourly: {
      time: Array.from({ length: 48 }, (_, i) => {
        const day = i < 24 ? "04" : "05";
        return `2026-11-${day}T${String(i % 24).padStart(2, "0")}:00`;
      }),
      temperature_2m: Array.from({ length: 48 }, (_, i) => i),
      weather_code: Array.from({ length: 48 }, () => 1),
      is_day: Array.from({ length: 48 }, (_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
    },
    daily: {
      time: ["2026-11-04", "2026-11-05"],
      sunrise: ["2026-11-04T05:42", "2026-11-05T05:43"],
      sunset: ["2026-11-04T16:58", "2026-11-05T16:57"],
    },
  };

  it("starts the hourly strip at the current local hour and covers a day", () => {
    const forecast = parseForecast(raw);
    expect(forecast.hourly).toHaveLength(24);
    expect(forecast.hourly[0]?.time).toBe("2026-11-04T13:00");
    expect(forecast.hourly[23]?.time).toBe("2026-11-05T12:00");
    expect(forecast.current.isDay).toBe(true);
    expect(forecast.sunrise).toBe("2026-11-04T05:42");
  });

  it("reads optional values as unknown when the service leaves them out", () => {
    const forecast = parseForecast(raw);
    expect(forecast.current.windDirection).toBeNull();
    expect(forecast.current.cloudCover).toBeNull();
    expect(forecast.hourly[0]?.precipChance).toBeNull();
    expect(forecast.daily).toEqual([]);
  });

  it("reads the daily outlook and precipitation chances", () => {
    const forecast = parseForecast({
      ...raw,
      current: { ...raw.current, wind_direction_10m: 250, cloud_cover: 80, precipitation: 0.4 },
      hourly: { ...raw.hourly, precipitation_probability: raw.hourly.time.map((_, i) => i) },
      daily: {
        ...raw.daily,
        weather_code: [61, 3],
        temperature_2m_max: [31, 29.5],
        temperature_2m_min: [22, null],
        precipitation_probability_max: [70, null],
      },
    });
    expect(forecast.current).toMatchObject({
      windDirection: 250,
      cloudCover: 80,
      precipitation: 0.4,
    });
    expect(forecast.hourly[0]?.precipChance).toBe(13);
    // A day missing its low is left out rather than shown wrong.
    expect(forecast.daily).toEqual([
      { date: "2026-11-04", code: 61, high: 31, low: 22, precipChance: 70 },
    ]);
  });

  it("treats the identical midnight times of polar night as no sunrise", () => {
    const polar = parseForecast({
      ...raw,
      daily: {
        ...raw.daily,
        sunrise: ["2026-11-04T00:00", null],
        sunset: ["2026-11-04T00:00", null],
      },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });

  it("treats the midnight-to-midnight span of polar day as no sunrise", () => {
    const polar = parseForecast({
      ...raw,
      daily: {
        ...raw.daily,
        sunrise: ["2026-11-04T00:00", null],
        sunset: ["2026-11-05T00:00", null],
      },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });

  it("keeps a real sunset that falls just after midnight", () => {
    const late = parseForecast({
      ...raw,
      daily: {
        ...raw.daily,
        sunrise: ["2026-11-04T02:10", null],
        sunset: ["2026-11-05T00:20", null],
      },
    });
    expect(late.sunrise).toBe("2026-11-04T02:10");
    expect(late.sunset).toBe("2026-11-05T00:20");
  });

  it("rejects a response missing a value, rather than showing it as zero", () => {
    const broken = {
      ...raw,
      current: { ...raw.current, temperature_2m: null as unknown as number },
    };
    expect(() => parseForecast(broken)).toThrow();
  });

  it("skips hours with no data", () => {
    const gappy = parseForecast({
      ...raw,
      hourly: {
        ...raw.hourly,
        temperature_2m: raw.hourly.temperature_2m.map((t, i) => (i === 14 ? null : t)),
      },
    });
    expect(gappy.hourly.map((h) => h.time)).not.toContain("2026-11-04T14:00");
    expect(gappy.hourly).toHaveLength(24);
  });

  it("treats a missing or wrong-day sunrise as none", () => {
    const polar = parseForecast({
      ...raw,
      daily: { ...raw.daily, sunrise: ["1970-01-01T00:00", null], sunset: [null, null] },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });
});

describe("current conditions batch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps order and turns rows without data into gaps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          {
            current: {
              temperature_2m: 10,
              weather_code: 3,
              cloud_cover: 90,
              wind_direction_10m: 200,
            },
          },
          { current: { temperature_2m: null, weather_code: 3 } },
          {},
        ]),
      ),
    );
    const rows = await fetchCurrentBatch([
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
      { lat: 3, lon: 3 },
    ]);
    expect(rows).toEqual([
      {
        temp: 10,
        code: 3,
        cloudCover: 90,
        precipitation: null,
        windSpeed: null,
        windDirection: 200,
      },
      null,
      null,
    ]);
  });
});

describe("sky weather refresh", () => {
  const CITIES = [{ lat: 1, lon: 2 }];
  const ROWS = [
    { temp: 20, code: 1, cloudCover: 10, precipitation: 0, windSpeed: 5, windDirection: 90 },
  ];
  const HOUR = 3_600_000;
  const save = (fetchedAt: number) =>
    localStorage.setItem(
      "weather-globe.sky-weather.v2",
      JSON.stringify({ fetchedAt, keys: ["1,2"], rows: ROWS }),
    );
  let store: Map<string, string>;
  let stop: (() => void) | undefined;
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    store = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => store.set(key, value),
    });
    vi.stubGlobal("document", {
      visibilityState: "visible",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () =>
      Response.json([{ current: { temperature_2m: 5, weather_code: 0 } }]),
    );
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    stop?.();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shows recently saved weather without a request", () => {
    const savedAt = Date.now() - HOUR / 2;
    save(savedAt);
    const onData = vi.fn();
    stop = startSkyWeather(CITIES, onData);
    expect(onData).toHaveBeenCalledWith(ROWS, savedAt);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't show saved weather from long ago, even with nothing newer", async () => {
    save(Date.now() - 7 * HOUR);
    fetchMock.mockRejectedValue(new Error("offline"));
    const onData = vi.fn();
    stop = startSkyWeather(CITIES, onData);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled();
  });

  it("refreshes and saves once the data is an hour old", async () => {
    save(Date.now() - 2 * HOUR);
    const onData = vi.fn();
    stop = startSkyWeather(CITIES, onData);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith(
      [
        {
          temp: 5,
          code: 0,
          cloudCover: null,
          precipitation: null,
          windSpeed: null,
          windDirection: null,
        },
      ],
      Date.now(),
    );
    expect(store.get("weather-globe.sky-weather.v2")).toContain('"temp":5');
  });

  it("retries after a failure, sooner than the hourly refresh, with increasing delays", async () => {
    fetchMock.mockRejectedValue(new Error("HTTP 429"));
    stop = startSkyWeather(CITIES, vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // The second failure waits two minutes.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

describe("sky conditions", () => {
  it("reads precipitation type and strength from the weather code", () => {
    expect(skyFor(0)).toMatchObject({ precip: 0, thunder: 0 });
    expect(skyFor(0).cloud).toBeLessThan(0.1);
    expect(skyFor(65).precip).toBeGreaterThan(skyFor(61).precip);
    expect(skyFor(75)).toMatchObject({ snow: 1 });
    expect(skyFor(99)).toMatchObject({ thunder: 1, hail: true });
    expect(skyFor(45).fog).toBe(1);
  });

  it("prefers measured cloud cover, but never calls a wet sky clear", () => {
    expect(skyFor(2, { cloudCover: 20 }).cloud).toBeCloseTo(0.2);
    expect(skyFor(61, { cloudCover: 5 }).cloud).toBeGreaterThan(0.7);
  });

  it("finds rain the code missed, as snow when it's freezing", () => {
    const rain = skyFor(3, { precipitation: 2, temp: 12 });
    expect(rain.precip).toBeGreaterThan(0.5);
    expect(rain.snow).toBe(0);
    expect(skyFor(3, { precipitation: 2, temp: -6 }).snow).toBe(1);
  });

  it("has an answer for an unknown code", () => {
    expect(skyFor(1234)).toMatchObject({ precip: 0, thunder: 0, fog: 0 });
  });
});

describe("sky field", () => {
  const date = new Date("2026-11-04T12:00:00Z");
  const sample = (lat: number, lon: number, code: number) => ({ lat, lon, sky: skyFor(code) });

  it("follows samples where they are and the climate where they aren't", () => {
    const field = buildSkyField([sample(10, 20, 0), sample(50, -30, 65)], date);
    expect(field).toHaveLength(FIELD_WIDTH * FIELD_HEIGHT * 4);
    expect(sampleSkyField(field, 10, 20).cloud).toBeLessThan(0.15);
    const storm = sampleSkyField(field, 50, -30);
    expect(storm.cloud).toBeGreaterThan(0.9);
    expect(storm.precip).toBeGreaterThan(0.7);
    // Rain stays near the sample that reported it.
    expect(sampleSkyField(field, 50, 10).precip).toBe(0);
    const far = sampleSkyField(field, -40, 150);
    expect(far.cloud).toBeCloseTo(climateCloud(-40, 150, 308.5), 1);
  });

  it("wraps across the antimeridian", () => {
    const field = buildSkyField([sample(0, 179.5, 63)], date);
    expect(sampleSkyField(field, 0, -179.5).precip).toBeGreaterThan(0.4);
    expect(sampleSkyField(field, 0, 179.9).precip).toBeCloseTo(
      sampleSkyField(field, 0, -179.9).precip,
      2,
    );
  });

  it("keeps the snow share and lightning of what falls", () => {
    const field = buildSkyField([sample(60, 90, 75), sample(-5, -60, 95)], date);
    expect(sampleSkyField(field, 60, 90).snow).toBeGreaterThan(0.95);
    expect(sampleSkyField(field, -5, -60).thunder).toBeGreaterThan(0.5);
    expect(sampleSkyField(field, -5, -60).snow).toBe(0);
  });

  it("puts the climate's clouds where they belong", () => {
    const july = 196;
    expect(climateCloud(23, 10, july)).toBeLessThan(0.2); // Sahara
    expect(climateCloud(-58, 0, july)).toBeGreaterThan(0.7); // Southern Ocean
    expect(climateCloud(8, -140, july)).toBeGreaterThan(climateCloud(25, -140, july)); // ITCZ
  });
});

describe("sky points", () => {
  it("fill the gaps between cities, far from all of them", () => {
    const points = skyPoints(majorCities);
    expect(points.length).toBeGreaterThan(80);
    expect(points.length).toBeLessThan(130);
    const minDot = Math.cos(990 / 6371);
    for (const point of points) {
      const [x, y, z] = latLonToVec3(point.lat, point.lon);
      for (const city of majorCities) {
        const [cx, cy, cz] = latLonToVec3(city.lat, city.lon);
        expect(x * cx + y * cy + z * cz).toBeLessThan(minDot);
      }
    }
  });

  it("are the same every time, so saved rows stay aligned", () => {
    expect(skyPoints(majorCities)).toEqual(skyPoints(majorCities));
  });
});
