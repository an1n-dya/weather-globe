export const DEG = Math.PI / 180;

export type Vec3 = [number, number, number];

/**
 * Globe convention: +Y is north. Longitude 0 faces +Z and east is +X, so with
 * the camera outside the sphere and north up, east is on the right.
 */
export function latLonToVec3(lat: number, lon: number, radius = 1): Vec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const cosPhi = Math.cos(phi);
  return [
    radius * cosPhi * Math.sin(lambda),
    radius * Math.sin(phi),
    radius * cosPhi * Math.cos(lambda),
  ];
}

export function vec3ToLatLon(x: number, y: number, z: number): { lat: number; lon: number } {
  const length = Math.hypot(x, y, z) || 1;
  const lat = Math.asin(Math.max(-1, Math.min(1, y / length))) / DEG;
  // At the poles longitude is undefined; atan2(0, 0) gives a stable 0.
  const lon = Math.atan2(x, z) / DEG;
  return { lat, lon: normalizeLon(lon) };
}

/** Wraps a longitude into [-180, 180). */
export function normalizeLon(lon: number): number {
  const wrapped = ((((lon + 180) % 360) + 360) % 360) - 180;
  return Object.is(wrapped, -0) ? 0 : wrapped;
}

/** Shortest signed longitude step from `from` to `to`, in [-180, 180). */
export function lonDelta(from: number, to: number): number {
  return normalizeLon(to - from);
}

/** Great-circle separation in degrees. */
export function angularDistanceDeg(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const [ax, ay, az] = latLonToVec3(a.lat, a.lon);
  const [bx, by, bz] = latLonToVec3(b.lat, b.lon);
  const dot = ax * bx + ay * by + az * bz;
  return Math.acos(Math.max(-1, Math.min(1, dot))) / DEG;
}

export function formatCoords(lat: number, lon: number): string {
  const ns = lat >= 0 ? 'N' : 'S';
  const ew = lon >= 0 ? 'E' : 'W';
  return `${Math.abs(lat).toFixed(2)}°${ns} ${Math.abs(lon).toFixed(2)}°${ew}`;
}
