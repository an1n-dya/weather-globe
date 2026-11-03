import tzlookup from '@photostructure/tz-lookup';
import { normalizeLon } from './coords';

/** The nominal ocean zone for a longitude. IANA Etc zones invert the sign. */
export function nominalZone(lon: number): string {
  const hours = Math.round(normalizeLon(lon) / 15);
  // An invalid zone would throw while rendering, so never build one from NaN.
  if (hours === 0 || Number.isNaN(hours)) return 'Etc/GMT';
  return hours > 0 ? `Etc/GMT-${hours}` : `Etc/GMT+${-hours}`;
}

function isSupportedZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The instant, on-device estimate. Lossy near borders, so it is replaced by
 * the zone the weather response reports once that arrives.
 */
export function estimateZone(lat: number, lon: number): string {
  try {
    const zone = tzlookup(lat, normalizeLon(lon));
    if (isSupportedZone(zone)) return zone;
  } catch {
    // Fall through to the longitude-based zone.
  }
  return nominalZone(lon);
}

/** Minutes ahead of UTC for an IANA zone at a moment, including DST. */
export function zoneOffsetMinutes(zone: string, date: Date): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    timeZoneName: 'longOffset',
  }).formatToParts(date);
  const name = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{1,2})(?::(\d{2}))?/.exec(name);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3] ?? 0);
  return match[1] === '-' ? -minutes : minutes;
}

export function formatOffset(minutes: number): string {
  if (minutes === 0) return 'UTC';
  const abs = Math.abs(minutes);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  return `UTC${minutes > 0 ? '+' : '−'}${hours}${rest ? `:${String(rest).padStart(2, '0')}` : ''}`;
}

/** Wording for how a place's clock compares with the viewer's. */
export function formatDifference(placeMinutes: number, viewerMinutes: number): string {
  const diff = placeMinutes - viewerMinutes;
  if (diff === 0) return 'Same time as you';
  const abs = Math.abs(diff);
  const hours = Math.floor(abs / 60);
  const rest = abs % 60;
  const amount = [hours ? `${hours}h` : '', rest ? `${rest}m` : ''].filter(Boolean).join(' ');
  return `${amount} ${diff > 0 ? 'ahead of' : 'behind'} you`;
}
