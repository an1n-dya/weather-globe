export type TempUnit = "c" | "f";
export type WindUnit = "kmh" | "mph" | "ms";

/** `|| 0` also turns a rounded -0 into 0, which would otherwise print as "-0". */
export function formatTemperature(celsius: number, unit: TempUnit): string {
  const value = unit === "f" ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(value) || 0}°`;
}

export function formatWind(kmh: number, unit: WindUnit): string {
  if (unit === "mph") return `${Math.round(kmh * 0.621371)} mph`;
  if (unit === "ms") return `${Math.round(kmh / 3.6)} m/s`;
  return `${Math.round(kmh)} km/h`;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;
const COMPASS_WORDS: Readonly<Record<string, string>> = {
  N: "north",
  NE: "northeast",
  E: "east",
  SE: "southeast",
  S: "south",
  SW: "southwest",
  W: "west",
  NW: "northwest",
};

/** The compass point a wind blows from, such as "SW" for 225°. */
export function compassPoint(degrees: number): (typeof COMPASS)[number] {
  return COMPASS[Math.round((((degrees % 360) + 360) % 360) / 45) % 8] ?? "N";
}

export function compassWords(degrees: number): string {
  return COMPASS_WORDS[compassPoint(degrees)] ?? "north";
}

/** Sea-level pressure in hPa, or inches of mercury alongside °F. */
export function formatPressure(hPa: number, unit: TempUnit): string {
  return unit === "f" ? `${(hPa * 0.02953).toFixed(2)} inHg` : `${Math.round(hPa)} hPa`;
}

/** Visibility in km, or miles where wind is in mph. Very long ranges read as "over". */
export function formatVisibility(meters: number, wind: WindUnit): string {
  if (wind === "mph") {
    const miles = meters / 1609.344;
    if (miles >= 10) return miles >= 30 ? "Over 30 mi" : `${Math.round(miles)} mi`;
    return `${miles.toFixed(1).replace(/\.0$/, "")} mi`;
  }
  const km = meters / 1000;
  if (km >= 10) return km >= 50 ? "Over 50 km" : `${Math.round(km)} km`;
  return `${km.toFixed(1).replace(/\.0$/, "")} km`;
}

/** The WHO's UV index categories. */
export function uvLevel(index: number): "Low" | "Moderate" | "High" | "Very high" | "Extreme" {
  const rounded = Math.round(index);
  if (rounded <= 2) return "Low";
  if (rounded <= 5) return "Moderate";
  if (rounded <= 7) return "High";
  if (rounded <= 10) return "Very high";
  return "Extreme";
}

/** "10 h 42 min" of daylight. */
export function formatDayLength(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** "Today", then short weekday names, for a local date like 2026-11-04. */
export function formatDayName(date: string, index: number): string {
  if (index === 0) return "Today";
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  // Noon UTC on that date, which is the same calendar day everywhere.
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(
    new Date(Date.UTC(y, m - 1, d, 12)),
  );
}

/** Minutes since local midnight, from an ISO-like local time such as 2026-11-04T13:05. */
export function minutesOfDay(iso: string): number {
  return Number(iso.slice(11, 13)) * 60 + Number(iso.slice(14, 16));
}

export function formatClock(date: Date, zone: string, hour12: boolean): string {
  // `hourCycle` rather than `hour12: false`, which printed midnight as 24:00 in older browsers.
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    hour: hour12 ? "numeric" : "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: hour12 ? "h12" : "h23",
  }).format(date);
}

export function formatDate(date: Date, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(date);
}

/** Formats the local wall-clock time in an ISO string like 2026-11-04T13:05. */
export function formatLocalTime(iso: string, hour12: boolean): string {
  const hours = Number(iso.slice(11, 13));
  const minutes = iso.slice(14, 16);
  if (!hour12) return `${String(hours).padStart(2, "0")}:${minutes}`;
  const suffix = hours < 12 ? "AM" : "PM";
  return `${hours % 12 || 12}:${minutes} ${suffix}`;
}

/** A shorter form for the hourly strip. */
export function formatLocalHour(iso: string, hour12: boolean): string {
  const hours = Number(iso.slice(11, 13));
  if (!hour12) return `${String(hours).padStart(2, "0")}:00`;
  return `${hours % 12 || 12} ${hours < 12 ? "AM" : "PM"}`;
}

export function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours} h ago`;
}
