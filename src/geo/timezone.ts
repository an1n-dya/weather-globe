import tzlookup from "@photostructure/tz-lookup";
import { normalizeLon } from "./coords";

/** The nominal ocean zone for a longitude. IANA Etc zones invert the sign. */
function nominalZone(lon: number): string {
  const hours = Math.round(normalizeLon(lon) / 15);
  // An invalid zone would throw while rendering, so never build one from NaN.
  if (hours === 0 || Number.isNaN(hours)) return "Etc/GMT";
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${-hours}`;
}

/** Older browsers don't know newer zone names, such as Europe/Kyiv. */
function isSupportedZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * Chooses the zone to show for a place. The zone reported with the weather is
 * the most accurate, but isn't available during a drag, so until then:
 * - On open water, the zone comes from longitude. The lookup's coarse ocean
 *   regions can land on a distant island's zone, a full calendar day off.
 * - Elsewhere, the zone comes from the on-device lookup, lossy near borders.
 */
export function zoneFor(
  lat: number,
  lon: number,
  overOcean: boolean,
  reportedZone?: string | null,
): string {
  if (reportedZone && isSupportedZone(reportedZone)) return reportedZone;
  if (overOcean) return nominalZone(lon);
  try {
    const zone = tzlookup(lat, normalizeLon(lon));
    if (isSupportedZone(zone)) return zone;
  } catch {
    // Fall through to the longitude-based zone.
  }
  return nominalZone(lon);
}

const offsetFormats = new Map<string, Intl.DateTimeFormat>();

/** Minutes ahead of UTC for an IANA zone at a moment, including DST. */
export function zoneOffsetMinutes(zone: string, date: Date): number {
  let format = offsetFormats.get(zone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "longOffset" });
    offsetFormats.set(zone, format);
  }
  const name = format.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "GMT";
  // Some engines write a true minus sign (U+2212) rather than a hyphen.
  const match = /GMT([+\-−])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === "+" ? minutes : -minutes;
}

export function formatOffset(minutes: number): string {
  if (minutes === 0) return "UTC";
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${minutes > 0 ? "+" : "−"}${hours}${rest ? `:${String(rest).padStart(2, "0")}` : ""}`;
}

const FRACTIONS: Readonly<Record<number, string>> = { 15: "¼", 30: "½", 45: "¾" };

/** "1 hour", "2 hours", "5½ hours", "45 minutes", "2 hours 20 minutes". */
export function formatDuration(totalMinutes: number): string {
  const abs = Math.abs(Math.round(totalMinutes));
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;
  if (hours === 0) return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  if (minutes === 0) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const fraction = FRACTIONS[minutes];
  if (fraction) return `${hours}${fraction} hours`;
  return `${hours} ${hours === 1 ? "hour" : "hours"} ${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

/** Wording for how a place's clock compares with the viewer's. */
export function formatDifference(placeMinutes: number, viewerMinutes: number): string {
  const diff = placeMinutes - viewerMinutes;
  if (diff === 0) return "Same time as you";
  return `${formatDuration(diff)} ${diff > 0 ? "ahead of" : "behind"} you`;
}

const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** The calendar date in a zone, as YYYY-MM-DD. */
function dateKey(date: Date, zone?: string): string {
  const key = zone ?? "";
  let format = dateFormats.get(key);
  if (!format) {
    format = new Intl.DateTimeFormat("en-CA", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormats.set(key, format);
  }
  return format.format(date);
}

/**
 * Whether it's already tomorrow, or still yesterday, at the place compared with
 * the viewer's own calendar. Across the date line this can differ by a day.
 */
export function relativeDay(
  date: Date,
  zone: string,
  viewerZone?: string,
): "today" | "tomorrow" | "yesterday" {
  const there = dateKey(date, zone);
  const here = dateKey(date, viewerZone);
  if (there === here) return "today";
  return there > here ? "tomorrow" : "yesterday";
}
