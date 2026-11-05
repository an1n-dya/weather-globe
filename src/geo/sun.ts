import { DEG, latLonToVec3, normalizeLon, type Vec3 } from "./coords";

const MS_PER_DAY = 86_400_000;
/** Where the sun's center sits at sunrise and sunset, once refraction is counted. */
const HORIZON_DEG = -0.83;

/**
 * The point on Earth with the sun directly overhead. Uses the low-precision
 * solar position formulas from the Astronomical Almanac, accurate to a small
 * fraction of a degree, which is far more than a stylized terminator needs.
 */
export function subsolarPoint(date: Date): { lat: number; lon: number } {
  const days = date.getTime() / MS_PER_DAY + 2440587.5 - 2451545;

  const meanAnomaly = (357.529 + 0.98560028 * days) * DEG;
  const meanLongitudeDeg = 280.459 + 0.98564736 * days;
  const eclipticLongitude =
    (meanLongitudeDeg + 1.915 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly)) * DEG;
  const obliquity = (23.439 - 0.00000036 * days) * DEG;

  const declination = Math.asin(Math.sin(obliquity) * Math.sin(eclipticLongitude));
  const rightAscension = Math.atan2(
    Math.cos(obliquity) * Math.sin(eclipticLongitude),
    Math.cos(eclipticLongitude),
  );

  // Equation of time in degrees: how far the true sun leads the mean sun.
  const equationOfTimeDeg = normalizeLon(meanLongitudeDeg - rightAscension / DEG);
  const msIntoDay = ((date.getTime() % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY;
  const utcHours = msIntoDay / 3_600_000;
  const lon = normalizeLon(-15 * (utcHours - 12) - equationOfTimeDeg);

  return { lat: declination / DEG, lon };
}

export function sunDirection(date: Date): Vec3 {
  const { lat, lon } = subsolarPoint(date);
  return latLonToVec3(lat, lon);
}

/** The sun's height above the horizon at a place, in degrees. */
export function sunAltitudeDeg(lat: number, lon: number, date: Date): number {
  const sun = sunDirection(date);
  const [x, y, z] = latLonToVec3(lat, lon);
  return Math.asin(x * sun[0] + y * sun[1] + z * sun[2]) / DEG;
}

export function isSunUp(lat: number, lon: number, date: Date): boolean {
  return sunAltitudeDeg(lat, lon, date) > HORIZON_DEG;
}
