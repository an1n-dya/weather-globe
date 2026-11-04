import { fetchCurrentBatch, type SkyCurrent } from "./provider";

const STORAGE_KEY = "weather-globe.sky-weather.v2";
const REFRESH_MS = 60 * 60_000;
const CHECK_MS = 60_000;
/** Saved weather older than this is no use, even when there's nothing newer to show. */
const MAX_SAVED_AGE_MS = 6 * 60 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 30 * 60_000;

interface Saved {
  fetchedAt: number;
  /** Rows aligned with the point list; the keys guard against a changed list. */
  keys: string[];
  rows: Array<SkyCurrent | null>;
}

const pointKey = (point: { lat: number; lon: number }) => `${point.lat},${point.lon}`;

function readSaved(keys: string[]): Saved | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const saved = JSON.parse(raw) as Saved;
    const matches =
      saved.keys?.length === keys.length && saved.keys.every((key, i) => key === keys[i]);
    return matches && Date.now() - saved.fetchedAt < MAX_SAVED_AGE_MS ? saved : null;
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
 * Keeps current conditions for the city markers and the cloud layer: one
 * batched request an hour, only while the tab is visible. `onData` receives
 * rows aligned with `points`, with the time they were measured. Returns a
 * function that stops it.
 */
export function startSkyWeather(
  points: ReadonlyArray<{ lat: number; lon: number }>,
  onData: (rows: Array<SkyCurrent | null>, fetchedAt: number) => void,
): () => void {
  const keys = points.map(pointKey);
  const saved = readSaved(keys);
  let fetchedAt = saved?.fetchedAt ?? 0;
  let failures = 0;
  let nextAttemptAt = 0;
  let inFlight = false;
  let stopped = false;
  const controller = new AbortController();

  if (saved) onData(saved.rows, saved.fetchedAt);

  const check = async () => {
    const now = Date.now();
    const due = now - fetchedAt >= REFRESH_MS && now >= nextAttemptAt;
    if (stopped || inFlight || !due || document.visibilityState !== "visible") return;
    inFlight = true;
    try {
      const rows = await fetchCurrentBatch(points, controller.signal);
      fetchedAt = Date.now();
      failures = 0;
      writeSaved({ fetchedAt, keys, rows });
      if (!stopped) onData(rows, fetchedAt);
    } catch {
      nextAttemptAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** failures, RETRY_MAX_MS);
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
