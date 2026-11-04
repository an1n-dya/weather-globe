/**
 * Checks time zones against the live weather service and fixed expected
 * offsets, and exercises the real API. Makes about 230 calls of the free quota:
 * the hourly batch counts each of its places.
 */
import majorCities from "../src/data/majorCities.json";
import { formatOffset, zoneFor, zoneOffsetMinutes } from "../src/geo/timezone";
import { fetchCurrentBatch, fetchForecast, searchPlaces } from "../src/weather/provider";
import { skyPoints } from "../src/weather/skyPoints";

// A fixed moment, so the expected offsets below hold whatever the season when this runs.
const REFERENCE_DATE = new Date("2026-11-04T12:00:00Z");

const places: Array<{ name: string; lat: number; lon: number; expected: string; ocean?: boolean }> =
  [
    { name: "Tokyo", lat: 35.68, lon: 139.69, expected: "UTC+9" },
    { name: "London", lat: 51.51, lon: -0.13, expected: "UTC" },
    { name: "Kolkata", lat: 22.57, lon: 88.36, expected: "UTC+5:30" },
    { name: "Kathmandu", lat: 27.7, lon: 85.32, expected: "UTC+5:45" },
    { name: "Honolulu", lat: 21.31, lon: -157.86, expected: "UTC−10" },
    { name: "Apia", lat: -13.83, lon: -171.76, expected: "UTC+13" },
    { name: "New York", lat: 40.71, lon: -74.01, expected: "UTC−5" },
    { name: "Sydney", lat: -33.87, lon: 151.21, expected: "UTC+11" },
    { name: "Mid-Pacific", lat: 0, lon: -150, expected: "UTC−10", ocean: true },
    // The South Pole station keeps New Zealand time, in daylight time this month.
    { name: "South Pole", lat: -89, lon: 0, expected: "UTC+13" },
    { name: "North Pole", lat: 89, lon: 0, expected: "UTC" },
  ];

let failures = 0;
for (const { name, lat, lon, expected, ocean = false } of places) {
  const estimated = zoneFor(lat, lon, ocean);
  const estimatedOffset = formatOffset(zoneOffsetMinutes(estimated, REFERENCE_DATE));
  const forecast = await fetchForecast(lat, lon);
  const liveOffset = formatOffset(zoneOffsetMinutes(forecast.timezone, REFERENCE_DATE));
  const ok = estimatedOffset === expected && liveOffset === expected;
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "DIFF"} ${name.padEnd(12)} expected ${expected.padEnd(9)} estimate ${estimated} ${estimatedOffset}` +
      ` | service ${forecast.timezone} ${liveOffset}` +
      ` | ${forecast.current.temp}°C code ${forecast.current.code} sunrise ${forecast.sunrise} sunset ${forecast.sunset}` +
      ` hours ${forecast.hourly.length} days ${forecast.daily.length}`,
  );
}

const points = [...majorCities, ...skyPoints(majorCities)];
const rows = await fetchCurrentBatch(points);
const withCloud = rows.filter((row) => row?.cloudCover != null).length;
console.log(
  `batch: ${rows.filter(Boolean).length} of ${points.length} places, ${withCloud} with cloud cover`,
);
if (rows.length !== points.length || rows.some((row) => !row)) failures++;

const found = await searchPlaces("Kathmandu");
console.log(`search: ${found[0]?.name}, ${found[0]?.country} (${found[0]?.lat}, ${found[0]?.lon})`);

console.log(failures ? `${failures} difference(s)` : "all matched");
if (failures) process.exitCode = 1;
