import { normalizeLon } from '../geo/coords';

export interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

/** Small LRU cache. Expired entries stay readable, to show when a refresh fails. */
export class TtlCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 64,
    private readonly now: () => number = Date.now,
  ) {}

  get(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  isFresh(entry: CacheEntry<T>): boolean {
    return this.now() - entry.fetchedAt < this.ttlMs;
  }

  set(key: string, value: T): CacheEntry<T> {
    const entry = { value, fetchedAt: this.now() };
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    return entry;
  }
}

const CELLS_PER_DEGREE = 4;

/** Snaps coordinates to the 0.25° cell used for requests and caching. */
export function snapToCell(lat: number, lon: number): { lat: number; lon: number; key: string } {
  const snappedLat = Math.round(lat * CELLS_PER_DEGREE) / CELLS_PER_DEGREE;
  const snappedLon = normalizeLon(Math.round(lon * CELLS_PER_DEGREE) / CELLS_PER_DEGREE);
  return { lat: snappedLat, lon: snappedLon, key: `${snappedLat},${snappedLon}` };
}
