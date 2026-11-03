export interface SharedView {
  lat: number;
  lon: number;
  distance?: number;
}

/** Reads a view from a hash such as #22.57,88.36,1.80. Invalid input gives null. */
export function parseHash(hash: string): SharedView | null {
  const parts = hash.replace(/^#/, '').split(',');
  if (parts.length < 2 || parts.length > 3) return null;
  const [lat, lon, distance] = parts.map(Number);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  if (parts.length === 3 && (!Number.isFinite(distance) || distance <= 1)) return null;
  return parts.length === 3 ? { lat, lon, distance } : { lat, lon };
}

export function formatHash(lat: number, lon: number, distance: number): string {
  return `#${lat.toFixed(2)},${lon.toFixed(2)},${distance.toFixed(2)}`;
}
