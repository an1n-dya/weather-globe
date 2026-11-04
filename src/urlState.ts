export interface SharedView {
  lat: number;
  lon: number;
  distance?: number;
}

/** Reads a view from a hash such as #22.57,88.36,1.80. Invalid input gives null. */
export function parseHash(hash: string): SharedView | null {
  const parts = hash.replace(/^#/, "").split(",");
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => part.trim() === "")) return null;
  const [lat, lon, distance] = parts.map(Number) as [number, number, number?];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (distance === undefined) return { lat, lon };
  return Number.isFinite(distance) && distance > 1 ? { lat, lon, distance } : null;
}

export function formatHash(lat: number, lon: number, distance: number): string {
  return `#${lat.toFixed(2)},${lon.toFixed(2)},${distance.toFixed(2)}`;
}

/** With no shared link, start at the viewer's longitude, estimated from their clock. */
export function initialView(): SharedView {
  const shared = parseHash(location.hash);
  if (shared) return shared;
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  return { lat: 20, lon: Math.max(-180, Math.min(179, offsetHours * 15)) };
}
