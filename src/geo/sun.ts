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

export interface SunDay {
  /** Minutes after local midnight, or null if the sun doesn't rise or set that day. */
  sunrise: number | null;
  sunset: number | null;
  /** Minutes of daylight in the local day. */
  daylight: number;
  polar: "day" | "night" | null;
}

/**
 * Sunrise, sunset and day length for the local calendar day containing `now`,
 * found by stepping through the day. Uses the same sun as the globe's
 * terminator, so the two always agree. `minutesNow` is the local time of day.
 */
export function sunDay(lat: number, lon: number, now: Date, minutesNow: number): SunDay {
  const midnight = now.getTime() - minutesNow * 60_000;
  const STEP = 10;
  const altitude = (minute: number) =>
    sunAltitudeDeg(lat, lon, new Date(midnight + minute * 60_000));
  let sunrise: number | null = null;
  let sunset: number | null = null;
  let daylight = 0;
  let previous = altitude(0) - HORIZON_DEG;
  for (let minute = STEP; minute <= 1440; minute += STEP) {
    const current = altitude(minute) - HORIZON_DEG;
    // Linear interpolation is good to a minute or so at this step.
    const crossing = minute - STEP + (STEP * previous) / (previous - current);
    if (previous <= 0 && current > 0 && sunrise === null) sunrise = crossing;
    if (previous > 0 && current <= 0 && sunset === null) sunset = crossing;
    if (previous > 0 && current > 0) daylight += STEP;
    else if (previous > 0 || current > 0)
      daylight += previous > 0 ? crossing - (minute - STEP) : minute - crossing;
    previous = current;
  }
  const polar = sunrise === null && sunset === null ? (daylight > 0 ? "day" : "night") : null;
  return { sunrise, sunset, daylight: Math.round(daylight), polar };
}

/**
 * Whether the sun stays up all day ("day"), stays down all day ("night"), or
 * rises and sets (null), from its highest and lowest heights on that date.
 */
export function polarState(lat: number, date: Date): "day" | "night" | null {
  const declination = subsolarPoint(date).lat;
  const highest = 90 - Math.abs(lat - declination);
  const lowest = Math.abs(lat + declination) - 90;
  if (highest < HORIZON_DEG) return "night";
  if (lowest > HORIZON_DEG) return "day";
  return null;
}
