export type TempUnit = "c" | "f";

/** `|| 0` also turns a rounded -0 into 0, which would otherwise print as "-0". */
export function formatTemperature(celsius: number, unit: TempUnit): string {
  const value = unit === "f" ? (celsius * 9) / 5 + 32 : celsius;
  return `${Math.round(value) || 0}°`;
}

export function formatWind(kmh: number, unit: TempUnit): string {
  return unit === "f" ? `${Math.round(kmh * 0.621371)} mph` : `${Math.round(kmh)} km/h`;
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
