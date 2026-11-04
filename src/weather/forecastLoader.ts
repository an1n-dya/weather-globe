import { snapToCell, TtlCache } from "./cache";
import type { Forecast } from "./provider";

type ForecastStatus = "idle" | "loading" | "ready" | "error";

export interface ForecastState {
  key: string | null;
  status: ForecastStatus;
  /** May be older than the TTL while refreshing or after a failure. */
  data: Forecast | null;
  fetchedAt: number | null;
  /** When the next automatic attempt happens after a failure. */
  retryAt: number | null;
}

export const IDLE_FORECAST: ForecastState = {
  key: null,
  status: "idle",
  data: null,
  fetchedAt: null,
  retryAt: null,
};

const TTL_MS = 15 * 60_000;
const BACKOFF_BASE_MS = 5_000;
const BACKOFF_MAX_MS = 5 * 60_000;

type Fetcher = (lat: number, lon: number, signal: AbortSignal) => Promise<Forecast>;

interface LoaderOptions {
  now?: () => number;
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Loads the forecast for the selected place. Only the newest selection may
 * publish a result: older requests are aborted, and their late responses are
 * dropped even if the abort arrived too late to stop them.
 */
export class ForecastLoader {
  private readonly cache: TtlCache<Forecast>;
  private readonly now: () => number;
  private readonly setTimer: NonNullable<LoaderOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<LoaderOptions["clearTimer"]>;
  private cell: ReturnType<typeof snapToCell> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;
  private attempts = 0;
  private retryHandle: unknown = null;
  private inFlight = false;

  constructor(
    private readonly fetcher: Fetcher,
    private readonly publish: (state: ForecastState) => void,
    options: LoaderOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as number));
    this.cache = new TtlCache<Forecast>(TTL_MS, 64, this.now);
  }

  select(lat: number, lon: number): void {
    const cell = snapToCell(lat, lon);
    if (this.cell?.key === cell.key) {
      this.refreshIfExpired();
      return;
    }
    this.cell = cell;
    this.attempts = 0;
    this.cancelPending();
    this.load();
  }

  /** Reloads the current place once its data has aged out. */
  refreshIfExpired(): void {
    if (!this.cell || this.inFlight || this.retryHandle !== null) return;
    const entry = this.cache.get(this.cell.key);
    if (!entry || !this.cache.isFresh(entry)) this.load();
  }

  retryNow(): void {
    if (!this.cell || this.inFlight) return;
    this.cancelPending();
    this.load();
  }

  private cancelPending(): void {
    // Whatever is running no longer counts, even if the abort comes too late to stop it.
    this.generation++;
    this.controller?.abort();
    this.controller = null;
    this.inFlight = false;
    if (this.retryHandle !== null) {
      this.clearTimer(this.retryHandle);
      this.retryHandle = null;
    }
  }

  private load(): void {
    const cell = this.cell;
    if (!cell) return;

    const entry = this.cache.get(cell.key);
    if (entry && this.cache.isFresh(entry)) {
      this.publish({
        key: cell.key,
        status: "ready",
        data: entry.value,
        fetchedAt: entry.fetchedAt,
        retryAt: null,
      });
      return;
    }

    this.publish({
      key: cell.key,
      status: "loading",
      data: entry?.value ?? null,
      fetchedAt: entry?.fetchedAt ?? null,
      retryAt: null,
    });

    const generation = ++this.generation;
    const controller = new AbortController();
    this.controller = controller;
    this.inFlight = true;

    this.fetcher(cell.lat, cell.lon, controller.signal).then(
      (forecast) => {
        const saved = this.cache.set(cell.key, forecast);
        if (generation !== this.generation) return;
        this.inFlight = false;
        this.attempts = 0;
        this.publish({
          key: cell.key,
          status: "ready",
          data: forecast,
          fetchedAt: saved.fetchedAt,
          retryAt: null,
        });
      },
      () => {
        if (generation !== this.generation || controller.signal.aborted) return;
        this.inFlight = false;
        const delay = Math.min(BACKOFF_BASE_MS * 2 ** this.attempts, BACKOFF_MAX_MS);
        this.attempts++;
        const stale = this.cache.get(cell.key);
        this.publish({
          key: cell.key,
          status: "error",
          data: stale?.value ?? null,
          fetchedAt: stale?.fetchedAt ?? null,
          retryAt: this.now() + delay,
        });
        this.retryHandle = this.setTimer(() => {
          this.retryHandle = null;
          this.load();
        }, delay);
      },
    );
  }
}
