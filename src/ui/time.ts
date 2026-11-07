const partFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes since local midnight in a zone, with seconds as a fraction. */
export function minutesInZone(date: Date, zone: string): number {
  let format = partFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    partFormats.set(zone, format);
  }
  const parts = format.formatToParts(date);
  const value = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  return value("hour") * 60 + value("minute") + value("second") / 60;
}

/** A time of day given as minutes after midnight, on a 12- or 24-hour clock. */
export function formatMinutes(minutes: number, hour12: boolean): string {
  const total = Math.round(minutes) % 1440;
  const h = Math.floor(total / 60);
  const m = String(total % 60).padStart(2, "0");
  if (!hour12) return `${String(h).padStart(2, "0")}:${m}`;
  return `${h % 12 || 12}:${m} ${h < 12 ? "AM" : "PM"}`;
}

/** The local time in a zone, short, for a list row: "9:41 PM". */
export function formatShortTime(date: Date, zone: string, hour12: boolean): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      timeZone: zone,
      hour: hour12 ? "numeric" : "2-digit",
      minute: "2-digit",
      hourCycle: hour12 ? "h12" : "h23",
    }).format(date);
  } catch {
    return "";
  }
}
