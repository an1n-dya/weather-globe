/**
 * The only module that knows about the weather service. Replacing Open-Meteo,
 * or moving to a paid plan, should only touch this file.
 */
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HOURS_SHOWN = 12;

export interface HourForecast {
  /** Local wall-clock time at the place, e.g. 2026-11-04T13:00. */
  time: string;
  temp: number;
  code: number;
  isDay: boolean;
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
    code: number;
    isDay: boolean;
  };
  hourly: HourForecast[];
  sunrise: string | null;
  sunset: string | null;
}

export interface CityCurrent {
  temp: number;
  code: number;
  isDay: boolean;
}

export interface SearchResult {
  id: number;
  name: string;
  admin: string;
  country: string;
  lat: number;
  lon: number;
}

export class WeatherRequestError extends Error {
  constructor(readonly status: number) {
    super(`Weather request failed: HTTP ${status}`);
    this.name = 'WeatherRequestError';
  }
}

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new WeatherRequestError(response.status);
  return response.json();
}

interface RawForecast {
  timezone: string;
  current: {
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
    temperature_2m: Array<number | null>;
    weather_code: Array<number | null>;
    is_day: Array<number | null>;
  };
  daily: {
    time: string[];
    sunrise: Array<string | null>;
    sunset: Array<string | null>;
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
  const bothMidnight = sunrise?.endsWith('T00:00') && sunset?.endsWith('T00:00');
  const valid = sunrise && sunset && day && !bothMidnight && sunrise.startsWith(day);
  return valid ? { sunrise, sunset } : { sunrise: null, sunset: null };
}

export function parseForecast(raw: RawForecast): Forecast {
  const { current, hourly, daily } = raw;
  const currentHour = current.time.slice(0, 13);
  const startIndex = hourly.time.findIndex((t) => t.slice(0, 13) >= currentHour);

  const hours: HourForecast[] = [];
  if (startIndex >= 0) {
    for (let i = startIndex; i < hourly.time.length && hours.length < HOURS_SHOWN; i++) {
      const temp = hourly.temperature_2m[i];
      const code = hourly.weather_code[i];
      if (temp === null || code === null) continue;
      hours.push({ time: hourly.time[i], temp, code, isDay: hourly.is_day[i] === 1 });
    }
  }

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
    },
    hourly: hours,
    ...sunEvents(daily.sunrise[0], daily.sunset[0], daily.time[0]),
  };
}

export async function fetchForecast(lat: number, lon: number, signal?: AbortSignal): Promise<Forecast> {
  const params = new URLSearchParams({
    latitude: String(lat),
    longitude: String(lon),
    current:
      'temperature_2m,apparent_temperature,relative_humidity_2m,wind_speed_10m,weather_code,is_day',
    hourly: 'temperature_2m,weather_code,is_day',
    daily: 'sunrise,sunset',
    timezone: 'auto',
    forecast_days: '2',
  });
  return parseForecast((await getJson(`${FORECAST_URL}?${params}`, signal)) as RawForecast);
}

interface RawCurrentOnly {
  current?: { temperature_2m: number; weather_code: number; is_day: number };
}

/** Current conditions for many places in one request, in the same order. */
export async function fetchCitiesCurrent(
  cities: ReadonlyArray<{ lat: number; lon: number }>,
  signal?: AbortSignal,
): Promise<Array<CityCurrent | null>> {
  const params = new URLSearchParams({
    latitude: cities.map((c) => c.lat).join(','),
    longitude: cities.map((c) => c.lon).join(','),
    current: 'temperature_2m,weather_code,is_day',
  });
  const raw = await getJson(`${FORECAST_URL}?${params}`, signal);
  // A single location comes back as an object rather than a list.
  const rows = (Array.isArray(raw) ? raw : [raw]) as RawCurrentOnly[];
  return rows.map((row) =>
    row.current
      ? {
          temp: row.current.temperature_2m,
          code: row.current.weather_code,
          isDay: row.current.is_day === 1,
        }
      : null,
  );
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
  const params = new URLSearchParams({ name: query, count: '6', language: 'en', format: 'json' });
  const raw = (await getJson(`${GEOCODING_URL}?${params}`, signal)) as RawGeocoding;
  return (raw.results ?? []).map((r) => ({
    id: r.id,
    name: r.name,
    admin: r.admin1 ?? '',
    country: r.country ?? '',
    lat: r.latitude,
    lon: r.longitude,
  }));
}
