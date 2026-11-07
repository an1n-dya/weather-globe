/** Places the viewer saved or visited, kept in this browser only. */
export interface SavedPlace {
  name: string;
  region: string;
  lat: number;
  lon: number;
}

export interface PlaceLists {
  favorites: SavedPlace[];
  recents: SavedPlace[];
}

const KEY = "weather-globe.places.v1";
export const MAX_FAVORITES = 20;
export const MAX_RECENTS = 8;

/** Two entries are the same place when they are within about a kilometer. */
export function samePlace(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): boolean {
  return Math.abs(a.lat - b.lat) < 0.01 && Math.abs(a.lon - b.lon) < 0.01;
}

const isPlace = (value: unknown): value is SavedPlace => {
  const p = value as SavedPlace;
  return (
    typeof p === "object" &&
    p !== null &&
    typeof p.name === "string" &&
    typeof p.region === "string" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
};

export function loadPlaceLists(): PlaceLists {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<PlaceLists> | null;
    const list = (value: unknown, max: number) =>
      Array.isArray(value) ? value.filter(isPlace).slice(0, max) : [];
    return {
      favorites: list(raw?.favorites, MAX_FAVORITES),
      recents: list(raw?.recents, MAX_RECENTS),
    };
  } catch {
    return { favorites: [], recents: [] };
  }
}

export function savePlaceLists(lists: PlaceLists): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(lists));
  } catch {
    // Without storage the lists last for this visit only.
  }
}

/** Moves a place to the front of a list, without duplicates, keeping at most `max`. */
export function addToFront(list: SavedPlace[], place: SavedPlace, max: number): SavedPlace[] {
  return [place, ...list.filter((p) => !samePlace(p, place))].slice(0, max);
}
