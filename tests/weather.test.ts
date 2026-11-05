import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { snapToCell, TtlCache } from "../src/weather/cache";
import { startCityWeather } from "../src/weather/cityWeather";
import { ForecastLoader, type ForecastState } from "../src/weather/forecastLoader";
import { type Forecast, fetchCitiesCurrent, parseForecast } from "../src/weather/provider";
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
    code: 0,
    isDay: true,
  },
  hourly: [],
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

  it("starts the hourly strip at the current local hour", () => {
    const forecast = parseForecast(raw);
    expect(forecast.hourly).toHaveLength(12);
    expect(forecast.hourly[0]?.time).toBe("2026-11-04T13:00");
    expect(forecast.hourly[11]?.time).toBe("2026-11-05T00:00");
    expect(forecast.current.isDay).toBe(true);
    expect(forecast.sunrise).toBe("2026-11-04T05:42");
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
    expect(gappy.hourly).toHaveLength(12);
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

describe("city weather batch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps order and turns rows without data into gaps", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json([
          { current: { temperature_2m: 10, weather_code: 3 } },
          { current: { temperature_2m: null, weather_code: 3 } },
          {},
        ]),
      ),
    );
    const rows = await fetchCitiesCurrent([
      { lat: 1, lon: 1 },
      { lat: 2, lon: 2 },
      { lat: 3, lon: 3 },
    ]);
    expect(rows).toEqual([{ temp: 10, code: 3 }, null, null]);
  });
});

describe("city weather refresh", () => {
  const CITIES = [{ lat: 1, lon: 2 }];
  const ROWS = [{ temp: 20, code: 1 }];
  const HOUR = 3_600_000;
  const save = (fetchedAt: number) =>
    localStorage.setItem(
      "weather-globe.city-weather.v1",
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
    save(Date.now() - HOUR / 2);
    const onData = vi.fn();
    stop = startCityWeather(CITIES, onData);
    expect(onData).toHaveBeenCalledWith(ROWS);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("doesn't show saved weather from long ago, even with nothing newer", async () => {
    save(Date.now() - 7 * HOUR);
    fetchMock.mockRejectedValue(new Error("offline"));
    const onData = vi.fn();
    stop = startCityWeather(CITIES, onData);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled();
  });

  it("refreshes and saves once the data is an hour old", async () => {
    save(Date.now() - 2 * HOUR);
    const onData = vi.fn();
    stop = startCityWeather(CITIES, onData);
    await vi.advanceTimersByTimeAsync(0);
    expect(onData).toHaveBeenLastCalledWith([{ temp: 5, code: 0 }]);
    expect(store.get("weather-globe.city-weather.v1")).toContain('"temp":5');
  });

  it("retries after a failure, sooner than the hourly refresh, with increasing delays", async () => {
    fetchMock.mockRejectedValue(new Error("HTTP 429"));
    stop = startCityWeather(CITIES, vi.fn());
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
