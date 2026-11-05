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
  /** Percent, when the service has an estimate. */
  precipChance: number | null;
}

export interface DayForecast {
  /** Local date at the place, e.g. 2026-11-04. */
  date: string;
  code: number;
  high: number;
  low: number;
  precipChance: number | null;
}

export interface Forecast {
  /** IANA zone from the service; more reliable than the on-device estimate. */
  timezone: string;
  current: {
    time: string;
    temp: number;
    feelsLike: number;
    humidity: number;
    wind: number;
    /** Degrees clockwise from north that the wind blows from. */
    windDirection: number | null;
    code: number;
    isDay: boolean;
    /** Percent. */
    cloudCover: number | null;
    /** Millimetres. */
    precipitation: number | null;
  };
  hourly: HourForecast[];
  daily: DayForecast[];
  sunrise: string | null;
  sunset: string | null;
}

/** Current conditions at one of many places fetched together. */
export interface SkyCurrent {
  temp: number;
  code: number;
  cloudCover: number | null;
  precipitation: number | null;
  windSpeed: number | null;
  windDirection: number | null;
}

export interface SearchResult {
  id: number;
  name: string;
  admin: string;
  country: string;
  lat: number;
  lon: number;
}

/** Fetches JSON, giving up if the caller aborts or the service stops responding. */
async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const timer = setTimeout(abort, REQUEST_TIMEOUT_MS);
  if (signal?.aborted) abort();
  signal?.addEventListener("abort", abort);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`Request failed: HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

const isNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/** A value the display can do without: missing simply means unknown. */
const optional = (value: unknown): number | null => (isNumber(value) ? value : null);

/** A missing value must not reach the display, where it would read as zero. */
function requireNumbers(...values: unknown[]): void {
  if (!values.every(isNumber)) throw new Error("Weather response is missing a value");
}

interface RawForecast {
  timezone: string;
  current: {
    time: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    wind_speed_10m: number;
    wind_direction_10m?: number | null;
    weather_code: number;
    is_day: number;
    cloud_cover?: number | null;
    precipitation?: number | null;
  };
  hourly: {
    time: string[];
    temperature_2m: Array<number | null>;
    weather_code: Array<number | null>;
    is_day: Array<number | null>;
    precipitation_probability?: Array<number | null>;
  };
  daily: {
    time: string[];
    sunrise: Array<string | null>;
    sunset: Array<string | null>;
    weather_code?: Array<number | null>;
    temperature_2m_max?: Array<number | null>;
    temperature_2m_min?: Array<number | null>;
    precipitation_probability_max?: Array<number | null>;
  };
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

function parseDays(daily: RawForecast["daily"]): DayForecast[] {
  const days: DayForecast[] = [];
  daily.time.forEach((date, i) => {
    const code = daily.weather_code?.[i];
    const high = daily.temperature_2m_max?.[i];
    const low = daily.temperature_2m_min?.[i];
    if (!isNumber(code) || !isNumber(high) || !isNumber(low) || days.length >= DAYS_SHOWN) return;
    days.push({
      date,
      code,
      high,
      low,
      precipChance: optional(daily.precipitation_probability_max?.[i]),
    });
  });
  return days;
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
    const temp = hourly.temperature_2m[i];
    const code = hourly.weather_code[i];
    if (time.slice(0, 13) < currentHour || hours.length >= HOURS_SHOWN) return;
    if (temp == null || code == null) return;
    hours.push({
      time,
      temp,
      code,
      isDay: hourly.is_day[i] === 1,
      precipChance: optional(hourly.precipitation_probability?.[i]),
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
      windDirection: optional(current.wind_direction_10m),
      code: current.weather_code,
      isDay: current.is_day === 1,
      cloudCover: optional(current.cloud_cover),
      precipitation: optional(current.precipitation),
    },
    hourly: hours,
    daily: parseDays(daily),
    ...sunEvents(daily.sunrise[0], daily.sunset[0], daily.time[0]),
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
    current:
      "temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,wind_direction_10m,weather_code,is_day,cloud_cover,precipitation",
    hourly: "temperature_2m,weather_code,is_day,precipitation_probability",
    daily:
      "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,sunrise,sunset",
    timezone: "auto",
    forecast_days: String(DAYS_SHOWN),
    forecast_hours: String(HOURS_SHOWN),
  });
  return parseForecast((await getJson(`${FORECAST_URL}?${params}`, signal)) as RawForecast);
}

interface RawCurrentOnly {
  current?: {
    temperature_2m?: number | null;
    weather_code?: number | null;
    cloud_cover?: number | null;
    precipitation?: number | null;
    wind_speed_10m?: number | null;
    wind_direction_10m?: number | null;
  };
}

/** Current conditions for many places in one request, in the same order. */
export async function fetchCurrentBatch(
  points: ReadonlyArray<{ lat: number; lon: number }>,
  signal?: AbortSignal,
): Promise<Array<SkyCurrent | null>> {
  const params = new URLSearchParams({
    latitude: points.map((p) => p.lat).join(","),
    longitude: points.map((p) => p.lon).join(","),
    current:
      "temperature_2m,weather_code,cloud_cover,precipitation,wind_speed_10m,wind_direction_10m",
  });
  const raw = await getJson(`${FORECAST_URL}?${params}`, signal);
  // A single location comes back as an object rather than a list.
  const rows = (Array.isArray(raw) ? raw : [raw]) as RawCurrentOnly[];
  return rows.map(({ current }) => {
    if (!isNumber(current?.temperature_2m) || !isNumber(current.weather_code)) return null;
    return {
      temp: current.temperature_2m,
      code: current.weather_code,
      cloudCover: optional(current.cloud_cover),
      precipitation: optional(current.precipitation),
      windSpeed: optional(current.wind_speed_10m),
      windDirection: optional(current.wind_direction_10m),
    };
  });
}

interface RawGeocoding {
  results?: Array<{
    id: number;
    name: string;
    admin1?: string;
    country?: string;
    latitude: number;
    longitude: number;
  }>;
}

export async function searchPlaces(query: string, signal?: AbortSignal): Promise<SearchResult[]> {
  const params = new URLSearchParams({ name: query, count: "6", language: "en", format: "json" });
  const raw = (await getJson(`${GEOCODING_URL}?${params}`, signal)) as RawGeocoding;
  return (raw.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    admin: r.admin1 ?? "",
    country: r.country ?? "",
    lat: r.latitude,
    lon: r.longitude,
  }));
}
