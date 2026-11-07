import { type CityCurrent, fetchCitiesCurrent, WeatherError } from "./provider";

const STORAGE_KEY = "weather-globe.city-weather.v1";
const REFRESH_MS = 60 * 60_000;
const CHECK_MS = 60_000;
/** Saved weather older than this is no use, even when there's nothing newer to show. */
const MAX_SAVED_AGE_MS = 6 * 60 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

interface Saved {
  fetchedAt: number;
  /** Rows aligned with the city list; the keys guard against a changed list. */
  keys: string[];
  rows: Array<CityCurrent | null>;
}

const cityKey = (city: { lat: number; lon: number }) => `${city.lat},${city.lon}`;

const isRow = (row: unknown): row is CityCurrent | null =>
  row === null ||
  (typeof row === "object" &&
    Number.isFinite((row as CityCurrent).temp) &&
    Number.isFinite((row as CityCurrent).code));

/** Saved weather only counts if it is recent, for the same cities, and well formed. */
function readSaved(keys: string[]): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Partial<Saved> | null;
    if (
      !saved ||
      typeof saved.fetchedAt !== "number" ||
      !Array.isArray(saved.keys) ||
      !Array.isArray(saved.rows) ||
      saved.keys.length !== keys.length ||
      saved.rows.length !== keys.length ||
      !saved.keys.every((key, i) => key === keys[i]) ||
      !saved.rows.every(isRow)
    ) {
      return null;
    }
    const age = Date.now() - saved.fetchedAt;
    return age >= 0 && age < MAX_SAVED_AGE_MS ? (saved as Saved) : null;
  } catch {
    return null;
  }
}

function writeSaved(saved: Saved): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // Storage may be full or blocked; the next visit simply fetches again.
  }
}

/**
 * Keeps the major-city markers current: one batched request an hour, only
 * while the tab is visible. Returns a function that stops it.
 */
export function startCityWeather(
  cities: ReadonlyArray<{ lat: number; lon: number }>,
  onData: (rows: Array<CityCurrent | null>) => void,
): () => void {
  const keys = cities.map(cityKey);
  const saved = readSaved(keys);
  let fetchedAt = saved?.fetchedAt ?? 0;
  let failures = 0;
  let nextAttemptAt = 0;
  let inFlight = false;
  let stopped = false;
  const controller = new AbortController();

  if (saved) onData(saved.rows);

  const check = async () => {
    const now = Date.now();
    const due = now - fetchedAt >= REFRESH_MS && now >= nextAttemptAt;
    if (stopped || inFlight || !due || document.visibilityState !== "visible") return;
    inFlight = true;
    try {
      const rows = await fetchCitiesCurrent(cities, controller.signal);
      fetchedAt = Date.now();
      failures = 0;
      writeSaved({ fetchedAt, keys, rows });
      if (!stopped) onData(rows);
    } catch (error) {
      const backoff = Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
      const asked = error instanceof WeatherError ? (error.retryAfterMs ?? 0) : 0;
      nextAttemptAt = Date.now() + Math.max(backoff, asked);
      failures++;
    } finally {
      inFlight = false;
    }
  };

  const onOnline = () => {
    nextAttemptAt = 0;
    void check();
  };

  void check();
  const interval = setInterval(() => void check(), CHECK_MS);
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", onOnline);

  return () => {
    stopped = true;
    controller.abort();
    clearInterval(interval);
    document.removeEventListener("visibilitychange", check);
    window.removeEventListener("online", onOnline);
  };
}
