/**
 * The only module that knows about the weather service. Replacing Open-Meteo,
 * or moving to a paid plan, should only touch this file.
 */
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";
const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const HOURS_SHOWN = 24;
const DAYS_SHOWN = 7;
const REQUEST_TIMEOUT_MS = 15_000;

export interface HourForecast {
  /** Local wall-clock time at the place, e.g. 2026-11-04T13:00. */
  time: string;
  temp: number;
  code: number;
  isDay: boolean;
  /** Chance of rain or snow, in percent. */
  precipChance: number | null;
}

export interface DayForecast {
  /** Local date, e.g. 2026-11-04. */
  date: string;
  code: number;
  max: number;
  min: number;
  precipChance: number | null;
  sunrise: string | null;
  sunset: string | null;
  uvMax: number | null;
  /** Seconds of daylight; 0 in polar night and 86,400 in polar day. */
  daylight: number | null;
}

export interface Forecast {
  /** IANA zone from the service; more reliable than the on-device estimate. */
  timezone: string;
  current: {
    time: string;
    temp: number;
    feelsLike: number;
    humidity: number;
    /** km/h. */
    wind: number;
    code: number;
    isDay: boolean;
    /** Degrees the wind comes from, clockwise from north. */
    windDirection: number | null;
    windGusts: number | null;
    dewPoint: number | null;
    /** Sea-level pressure, hPa. */
    pressure: number | null;
    /** Percent. */
    cloudCover: number | null;
    /** Meters. */
    visibility: number | null;
    uvIndex: number | null;
  };
  hourly: HourForecast[];
  daily: DayForecast[];
  /** Today's, at the place. */
  sunrise: string | null;
  sunset: string | null;
  daylight: number | null;
}

export interface CityCurrent {
  temp: number;
  code: number;
}

export interface SearchResult {
  id: number;
  name: string;
  admin: string;
  country: string;
  /** ISO 3166-1 alpha-2, for the flag. */
  countryCode: string;
  /** IANA zone, for the local time beside each result. */
  timezone: string;
  lat: number;
  lon: number;
}

/** Why a request failed, which decides what the interface says and when to try again. */
export type WeatherProblem = "offline" | "busy" | "timeout" | "unavailable";

export class WeatherError extends Error {
  constructor(
    message: string,
    readonly problem: WeatherProblem,
    /** How long the service asked us to wait, from a Retry-After header. */
    readonly retryAfterMs: number | null = null,
  ) {
    super(message);
    this.name = "WeatherError";
  }
}

const MAX_RETRY_AFTER_MS = 10 * 60_000;

/** Retry-After is either a number of seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  if (!Number.isFinite(ms)) return null;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, ms));
}

const isOffline = () => typeof navigator !== "undefined" && navigator.onLine === false;

/** Fetches JSON, giving up if the caller aborts or the service stops responding. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort();
  const timer = setTimeout(() => {
    timedOut = true;
    abort();
  }, REQUEST_TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);

  // The caller's own cancellation isn't a failure, so it passes through untouched.
  const explain = (error: unknown): never => {
    if (signal?.aborted || error instanceof WeatherError) throw error;
    if (timedOut) throw new WeatherError("The weather service didn't answer in time", "timeout");
    if (isOffline()) throw new WeatherError("This device is offline", "offline");
    throw new WeatherError("Could not reach the weather service", "unavailable");
  };

  try {
    const response = await fetch(url, { signal: controller.signal }).catch(explain);
    if (!response.ok) {
      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const problem = response.status === 429 ? "busy" : "unavailable";
      throw new WeatherError(`Request failed: HTTP ${response.status}`, problem, retryAfter);
    }
    return await response.json().catch(explain);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/** A missing value must not reach the display, where it would read as zero. */
function requireNumbers(...values: unknown[]): void {
  if (!values.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error("Weather response is missing a value");
  }
}

type Series<T> = Array<T | null> | undefined;

interface RawForecast {
  timezone: string;
  current: Record<string, number | string | null | undefined> & {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    weather_code: number;
    is_day: number;
  };
  hourly: {
    time: string[];
    temperature_2m: Series<number>;
    weather_code: Series<number>;
    is_day: Series<number>;
    precipitation_probability?: Series<number>;
  };
  daily: {
    time: string[];
    sunrise: Series<string>;
    sunset: Series<string>;
    weather_code?: Series<number>;
    temperature_2m_max?: Series<number>;
    temperature_2m_min?: Series<number>;
    precipitation_probability_max?: Series<number>;
    uv_index_max?: Series<number>;
    daylight_duration?: Series<number>;
  };
}

/** A finite number, or null: optional values may be missing for some places or models. */
function optional(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Polar day and night have no real sunrise or sunset. The service reports
 * midnight for both rather than leaving them empty: today's midnight twice in
 * polar night, and today's then tomorrow's in polar day. A real sunset can fall
 * just after midnight, so only the pair of exact midnights is treated as none.
 */
function sunEvents(
  sunrise: string | null | undefined,
  sunset: string | null | undefined,
  day: string | undefined,
): { sunrise: string | null; sunset: string | null } {
  const bothMidnight = sunrise?.endsWith("T00:00") && sunset?.endsWith("T00:00");
  const valid = sunrise && sunset && day && !bothMidnight && sunrise.startsWith(day);
  return valid ? { sunrise, sunset } : { sunrise: null, sunset: null };
}

export function parseForecast(raw: RawForecast): Forecast {
  const { current, hourly, daily } = raw;
  requireNumbers(
    current.temperature_2m,
    current.apparent_temperature,
    current.relative_humidity_2m,
    current.wind_speed_10m,
    current.weather_code,
  );

  const currentHour = current.time.slice(0, 13);
  const hours: HourForecast[] = [];
  hourly.time.forEach((time, i) => {
    const temp = optional(hourly.temperature_2m?.[i]);
    const code = optional(hourly.weather_code?.[i]);
    if (time.slice(0, 13) < currentHour || hours.length >= HOURS_SHOWN) return;
    if (temp === null || code === null) return;
    hours.push({
      time,
      temp,
      code,
      isDay: hourly.is_day?.[i] === 1,
      precipChance: optional(hourly.precipitation_probability?.[i]),
    });
  });

  const days: DayForecast[] = [];
  daily.time.forEach((date, i) => {
    const max = optional(daily.temperature_2m_max?.[i]);
    const min = optional(daily.temperature_2m_min?.[i]);
    const code = optional(daily.weather_code?.[i]);
    if (days.length >= DAYS_SHOWN || max === null || min === null || code === null) return;
    days.push({
      date,
      code,
      max,
      min,
      precipChance: optional(daily.precipitation_probability_max?.[i]),
      ...sunEvents(daily.sunrise?.[i], daily.sunset?.[i], date),
      uvMax: optional(daily.uv_index_max?.[i]),
      daylight: optional(daily.daylight_duration?.[i]),
    });
  });

  return {
    timezone: raw.timezone,
    current: {
      time: current.time,
      temp: current.temperature_2m,
      feelsLike: current.apparent_temperature,
      humidity: current.relative_humidity_2m,
      wind: current.wind_speed_10m,
      code: current.weather_code,
      isDay: current.is_day === 1,
      windDirection: optional(current.wind_direction_10m),
      windGusts: optional(current.wind_gusts_10m),
      dewPoint: optional(current.dew_point_2m),
      pressure: optional(current.pressure_msl),
      cloudCover: optional(current.cloud_cover),
      visibility: optional(current.visibility),
      uvIndex: optional(current.uv_index),
    },
    hourly: hours,
    daily: days,
    ...sunEvents(daily.sunrise?.[0], daily.sunset?.[0], daily.time[0]),
    daylight: optional(daily.daylight_duration?.[0]),
  };
}

export async function fetchForecast(
  lat: number,
  lon: number,
  signal?: AbortSignal,
): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current: [
      "temperature_2m",
      "apparent_temperature",
      "relative_humidity_2m",
      "dew_point_2m",
      "wind_speed_10m",
      "wind_direction_10m",
      "wind_gusts_10m",
      "weather_code",
      "is_day",
      "pressure_msl",
      "cloud_cover",
      "visibility",
      "uv_index",
    ].join(","),
    hourly: "temperature_2m,weather_code,is_day,precipitation_probability",
    daily: [
      "weather_code",
      "temperature_2m_max",
      "temperature_2m_min",
      "precipitation_probability_max",
      "sunrise",
      "sunset",
      "uv_index_max",
      "daylight_duration",
    ].join(","),
    timezone: "auto",
    forecast_days: String(DAYS_SHOWN),
  });
  return parseForecast((await getJson(`${FORECAST_URL}?${params}`, signal)) as RawForecast);
}

interface RawCurrentOnly {
  current?: { temperature_2m: number; weather_code: number };
}

/** Current conditions for many places in one request, in the same order. */
export async function fetchCitiesCurrent(
  cities: ReadonlyArray<{ lat: number; lon: number }>,
  signal?: AbortSignal,
): Promise<Array<CityCurrent | null>> {
  const params = new URLSearchParams({
    latitude: cities.map((c) => c.lat).join(","),
    longitude: cities.map((c) => c.lon).join(","),
    current: "temperature_2m,weather_code",
  });
  const raw = await getJson(`${FORECAST_URL}?${params}`, signal);
  // A single location comes back as an object rather than a list.
  const rows = (Array.isArray(raw) ? raw : [raw]) as RawCurrentOnly[];
  return rows.map(({ current }) =>
    typeof current?.temperature_2m === "number" && typeof current.weather_code === "number"
      ? { temp: current.temperature_2m, code: current.weather_code }
      : null,
  );
}

interface RawGeocoding {
  results?: Array<{
    id: number;
    name: string;
    admin1?: string;
    country?: string;
    country_code?: string;
    timezone?: string;
    latitude: number;
    longitude: number;
  }>;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ name: query, count: "6", language: "en", format: "json" });
  const raw = (await getJson(`${GEOCODING_URL}?${params}`, signal)) as RawGeocoding;
  return (raw.results ?? [])
    .filter((r) => Number.isFinite(r.latitude) && Number.isFinite(r.longitude) && r.name)
    .map((r) => ({
      id: r.id,
      name: r.name,
      admin: r.admin1 ?? "",
      country: r.country ?? "",
      countryCode: r.country_code ?? "",
      timezone: r.timezone ?? "",
      lat: r.latitude,
      lon: r.longitude,
    }));
}
