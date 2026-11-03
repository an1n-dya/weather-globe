import { fetchCitiesCurrent, type CityCurrent } from './provider';

const STORAGE_KEY = 'weather-globe.city-weather.v1';
const REFRESH_MS = 60 * 60_000;
const CHECK_MS = 60_000;
const RETRY_MS = 10 * 60_000;

interface Stored {
  fetchedAt: number;
  /** Rows aligned with the city list; the keys guard against a changed list. */
  keys: string[];
  rows: Array<CityCurrent | null>;
}

const cityKey = (city: { lat: number; lon: number }) => `${city.lat},${city.lon}`;

function readStored(keys: string[]): Stored | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const stored = JSON.parse(raw) as Stored;
    const matches =
      stored.keys?.length === keys.length && stored.keys.every((key, i) => key === keys[i]);
    return matches ? stored : null;
  } catch {
    return null;
  }
}

function writeStored(stored: Stored): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
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
  const stored = readStored(keys);
  let fetchedAt = stored?.fetchedAt ?? 0;
  let nextAttemptAt = 0;
  let inFlight = false;
  let stopped = false;
  const controller = new AbortController();

  if (stored) onData(stored.rows);

  const check = async () => {
    const now = Date.now();
    const due = now - fetchedAt >= REFRESH_MS && now >= nextAttemptAt;
    if (stopped || inFlight || !due || document.visibilityState !== 'visible') return;
    inFlight = true;
    try {
      const rows = await fetchCitiesCurrent(cities, controller.signal);
      fetchedAt = Date.now();
      writeStored({ fetchedAt, keys, rows });
      if (!stopped) onData(rows);
    } catch {
      nextAttemptAt = Date.now() + RETRY_MS;
    } finally {
      inFlight = false;
    }
  };

  void check();
  const interval = setInterval(() => void check(), CHECK_MS);
  document.addEventListener('visibilitychange', check);

  return () => {
    stopped = true;
    controller.abort();
    clearInterval(interval);
    document.removeEventListener('visibilitychange', check);
  };
}
