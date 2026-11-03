/**
 * Checks time zones against the live weather service and fixed expected
 * offsets, and exercises the real API. Makes about 110 calls of the free quota.
 */
import majorCities from '../src/data/majorCities.json';
import { estimateZone, formatOffset, nominalZone, zoneOffsetMinutes } from '../src/geo/timezone';
import { fetchCitiesCurrent, fetchForecast, searchPlaces } from '../src/weather/provider';

const now = new Date();
// Offsets for early November 2026, after northern DST has ended.
const places: Array<[string, number, number, string]> = [
  ['Tokyo', 35.68, 139.69, 'UTC+9'],
  ['London', 51.51, -0.13, 'UTC'],
  ['Kolkata', 22.57, 88.36, 'UTC+5:30'],
  ['Kathmandu', 27.7, 85.32, 'UTC+5:45'],
  ['Honolulu', 21.31, -157.86, 'UTC−10'],
  ['Apia', -13.83, -171.76, 'UTC+13'],
  ['New York', 40.71, -74.01, 'UTC−5'],
  ['Sydney', -33.87, 151.21, 'UTC+11'],
  ['Mid-Pacific', 0, -150, 'UTC−10'],
  // The South Pole station keeps New Zealand time, in daylight time this month.
  ['South Pole', -89, 0, 'UTC+13'],
  ['North Pole', 89, 0, 'UTC'],
];

let failures = 0;
for (const [name, lat, lon, expected] of places) {
  // The app uses the longitude-based zone over open water.
  const estimated = name === 'Mid-Pacific' ? nominalZone(lon) : estimateZone(lat, lon);
  const estimatedOffset = formatOffset(zoneOffsetMinutes(estimated, now));
  const forecast = await fetchForecast(lat, lon);
  const liveOffset = formatOffset(zoneOffsetMinutes(forecast.timezone, now));
  const ok = estimatedOffset === expected && liveOffset === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? 'ok  ' : 'DIFF'} ${name.padEnd(12)} expected ${expected.padEnd(9)} estimate ${estimated} ${estimatedOffset}` +
      ` | service ${forecast.timezone} ${liveOffset}` +
      ` | ${forecast.current.temp}°C code ${forecast.current.code} sunrise ${forecast.sunrise} sunset ${forecast.sunset} hours ${forecast.hourly.length}`,
  );
}

const rows = await fetchCitiesCurrent(majorCities);
console.log(`batch: ${rows.filter(Boolean).length} of ${majorCities.length} cities returned`);
if (rows.length !== majorCities.length || rows.some((r) => !r)) failures++;

const found = await searchPlaces('Kathmandu');
console.log(`search: ${found[0]?.name}, ${found[0]?.country} (${found[0]?.lat}, ${found[0]?.lon})`);

console.log(failures ? `${failures} difference(s)` : 'all matched');
