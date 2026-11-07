import { normalizeLon } from "./geo/coords";

export interface SharedView {
  lat: number;
  lon: number;
  distance?: number;
}

const NUMBER = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;

/**
 * Reads a view from a hash such as #22.57,88.36,1.80. Invalid input gives null.
 * Accepts commas that a chat app percent-encoded; anything malformed or out of
 * range is rejected.
 */
export function parseHash(hash: string): SharedView | null {
  let text = hash.replace(/^#/, "");
  try {
    text = decodeURIComponent(text);
  } catch {
    return null;
  }
  const parts = text.split(",").map((part) => part.trim());
  if (parts.length < 2 || parts.length > 3 || !parts.every((part) => NUMBER.test(part)))
    return null;
  const [lat, rawLon, distance] = parts.map(Number) as [number, number, number?];
  if (Math.abs(lat) > 90 || Math.abs(rawLon) > 180) return null;
  const lon = normalizeLon(rawLon);
  if (distance === undefined) return { lat, lon };
  return distance > 1 && distance < 100 ? { lat, lon, distance } : null;
}

export function formatHash(lat: number, lon: number, distance: number): string {
  return `#${lat.toFixed(2)},${lon.toFixed(2)},${distance.toFixed(2)}`;
}

/** Updates the address without adding to the history. Safari limits how often this may run. */
export function replaceHash(hash: string): void {
  if (location.hash === hash) return;
  try {
    history.replaceState(history.state, "", hash);
  } catch {
    // Over the limit: the next settle writes it.
  }
}

/** With no shared link, start at the viewer's longitude, estimated from their clock. */
export function initialView(): SharedView {
  const shared = parseHash(location.hash);
  if (shared) return shared;
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  return { lat: 20, lon: Math.max(-180, Math.min(179, offsetHours * 15)) };
}
