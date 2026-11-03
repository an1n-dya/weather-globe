import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { angularDistanceDeg, latLonToVec3, lonDelta, normalizeLon, vec3ToLatLon } from '../src/geo/coords';
import { subsolarPoint, sunDirection } from '../src/geo/sun';
import { formatDifference, formatOffset, nominalZone, zoneOffsetMinutes } from '../src/geo/timezone';
import { PlaceIndex, type CityRow } from '../src/geo/places';
import { buildEarthArrays } from '../src/globe/earthMesh';
import { buildIcosphere, faceCount, FREQUENCY_HIGH, FREQUENCY_LOW } from '../src/globe/icosphere';
import { formatAge, formatLocalHour, formatLocalTime, formatTemperature, formatWind } from '../src/ui/format';
import { formatHash, parseHash } from '../src/urlState';
import { snapToCell, TtlCache } from '../src/weather/cache';
import { ForecastLoader, type ForecastState } from '../src/weather/forecastLoader';
import { parseForecast, type Forecast } from '../src/weather/provider';
import { describeWeatherCode, WMO_CODES } from '../src/weather/wmo';

describe('coordinates', () => {
  it('puts north up and east to the right of a viewer at lon 0', () => {
    expect(latLonToVec3(90, 0)[1]).toBeCloseTo(1);
    expect(latLonToVec3(0, 0)[2]).toBeCloseTo(1);
    expect(latLonToVec3(0, 90)[0]).toBeCloseTo(1);
  });

  it.each([
    [0, 0], [51.5, -0.13], [-33.87, 151.21], [35.68, 139.69], [21.3, -157.86], [10, 179.99], [10, -179.99],
  ])('round-trips %f, %f', (lat, lon) => {
    const [x, y, z] = latLonToVec3(lat, lon);
    const result = vec3ToLatLon(x, y, z);
    expect(result.lat).toBeCloseTo(lat, 6);
    expect(result.lon).toBeCloseTo(lon, 6);
  });

  it('is stable at the poles', () => {
    const [x, y, z] = latLonToVec3(90, 0);
    expect(vec3ToLatLon(x, y, z).lat).toBeCloseTo(90, 6);
    expect(Number.isFinite(vec3ToLatLon(0, -1, 0).lon)).toBe(true);
    expect(vec3ToLatLon(0, -1, 0).lat).toBeCloseTo(-90, 6);
  });

  it('wraps across the antimeridian', () => {
    expect(normalizeLon(190)).toBeCloseTo(-170);
    expect(normalizeLon(-190)).toBeCloseTo(170);
    expect(lonDelta(179, -179)).toBeCloseTo(2);
    expect(lonDelta(-179, 179)).toBeCloseTo(-2);
    expect(angularDistanceDeg({ lat: 0, lon: 179 }, { lat: 0, lon: -179 })).toBeCloseTo(2);
  });
});

describe('sun position', () => {
  it.each([
    ['2026-03-20T14:46:00Z', 0],
    ['2026-06-21T08:25:00Z', 23.44],
    ['2026-09-23T00:06:00Z', 0],
    ['2026-12-21T20:50:00Z', -23.44],
  ])('declination at %s', (iso, expected) => {
    expect(subsolarPoint(new Date(iso)).lat).toBeCloseTo(expected, 0);
    expect(Math.abs(subsolarPoint(new Date(iso)).lat - expected)).toBeLessThan(0.1);
  });

  it('is over the prime meridian near 12:00 UTC when the equation of time is small', () => {
    // The equation of time is close to zero around 15 April.
    expect(Math.abs(subsolarPoint(new Date('2026-04-15T12:00:00Z')).lon)).toBeLessThan(0.5);
  });

  it('matches the equation of time in early November', () => {
    // The sun runs about 16.4 minutes ahead of the clock, about 4.1° of longitude.
    expect(subsolarPoint(new Date('2026-11-03T12:00:00Z')).lon).toBeCloseTo(-4.1, 0);
  });

  // Sunrise and sunset times reported by Open-Meteo, an independent source. At
  // these moments the sun's center sits about 0.83° below the horizon.
  it.each([
    ['Tokyo sunset', 35.68, 139.69, '2026-11-04T07:43:00Z'],
    ['Kolkata sunset', 22.57, 88.36, '2026-11-04T11:27:00Z'],
    ['Sydney sunrise', -33.87, 151.21, '2026-11-03T18:52:00Z'],
    ['London sunset', 51.51, -0.13, '2026-11-03T16:30:00Z'],
    ['Honolulu sunrise', 21.31, -157.86, '2026-11-03T16:35:00Z'],
  ])('puts the terminator in the right place: %s', (_name, lat, lon, iso) => {
    const sun = sunDirection(new Date(iso));
    const [x, y, z] = latLonToVec3(lat, lon);
    const altitude = (Math.asin(x * sun[0] + y * sun[1] + z * sun[2]) * 180) / Math.PI;
    expect(Math.abs(altitude + 0.83)).toBeLessThan(0.5);
  });

  it('moves west by 15° each hour', () => {
    const a = subsolarPoint(new Date('2026-07-01T06:00:00Z')).lon;
    const b = subsolarPoint(new Date('2026-07-01T07:00:00Z')).lon;
    expect(lonDelta(a, b)).toBeCloseTo(-15, 0);
  });
});

describe('time zones', () => {
  const winter = new Date('2026-01-15T12:00:00Z');
  const summer = new Date('2026-07-15T12:00:00Z');

  it('applies DST', () => {
    expect(zoneOffsetMinutes('America/New_York', winter)).toBe(-300);
    expect(zoneOffsetMinutes('America/New_York', summer)).toBe(-240);
    expect(zoneOffsetMinutes('Australia/Sydney', winter)).toBe(660);
    expect(zoneOffsetMinutes('Australia/Sydney', summer)).toBe(600);
  });

  it('handles fractional offsets', () => {
    expect(zoneOffsetMinutes('Asia/Kolkata', winter)).toBe(330);
    expect(zoneOffsetMinutes('Asia/Kathmandu', winter)).toBe(345);
  });

  it('shows the correct sign for inverted Etc zones', () => {
    expect(zoneOffsetMinutes('Etc/GMT+10', winter)).toBe(-600);
    expect(formatOffset(zoneOffsetMinutes('Etc/GMT+10', winter))).toBe('UTC−10');
    expect(zoneOffsetMinutes('Etc/GMT-5', winter)).toBe(300);
    expect(formatOffset(zoneOffsetMinutes('Etc/GMT-5', winter))).toBe('UTC+5');
  });

  it('derives ocean zones from longitude with the correct sign', () => {
    expect(formatOffset(zoneOffsetMinutes(nominalZone(-150), winter))).toBe('UTC−10');
    expect(formatOffset(zoneOffsetMinutes(nominalZone(75), winter))).toBe('UTC+5');
    expect(nominalZone(0)).toBe('Etc/GMT');
    expect(nominalZone(Number.NaN)).toBe('Etc/GMT');
    expect(formatOffset(zoneOffsetMinutes(nominalZone(179.9), winter))).toBe('UTC+12');
  });

  it('formats offsets and differences', () => {
    expect(formatOffset(0)).toBe('UTC');
    expect(formatOffset(330)).toBe('UTC+5:30');
    expect(formatOffset(-210)).toBe('UTC−3:30');
    expect(formatDifference(330, 330)).toBe('Same time as you');
    expect(formatDifference(330, 0)).toBe('5h 30m ahead of you');
    expect(formatDifference(0, 60)).toBe('1h behind you');
    expect(formatDifference(30, 0)).toBe('30m ahead of you');
  });
});

describe('weather codes', () => {
  it('maps every documented code to a labeled condition', () => {
    const documented = [
      0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99,
    ];
    expect(Object.keys(WMO_CODES).map(Number).sort((a, b) => a - b)).toEqual(documented);
    for (const code of documented) {
      expect(describeWeatherCode(code).label).not.toBe('Unknown');
    }
  });

  it('has a safe fallback', () => {
    expect(describeWeatherCode(1234)).toEqual({ label: 'Unknown', icon: 'cloudy' });
  });
});

describe('places', () => {
  const cities: CityRow[] = [
    ['Bigtown', 'IN', 22.57, 88.36, 4_500_000],
    ['Suburb', 'IN', 22.6, 88.34, 20_000],
    ['Edge East', 'FJ', -17, 179.9, 50_000],
  ];
  const landOnlyAt = (lat: number, lon: number) => {
    const grid = new Uint8Array(32400);
    const bit = Math.floor((90 - lat) * 2) * 720 + Math.floor((lon + 180) * 2);
    grid[bit >> 3] |= 1 << (bit & 7);
    return grid;
  };

  it('names the nearby city, favoring the larger one', () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    // Closer to the suburb, but the much larger city keeps the name.
    expect(index.describe(22.59, 88.35)).toMatchObject({ kind: 'city', name: 'Bigtown', region: 'India' });
  });

  it('says near for a city more than 25 km away', () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    expect(index.describe(23.2, 88.36)).toMatchObject({ kind: 'near', name: 'Near Bigtown' });
  });

  it('finds cities across the antimeridian', () => {
    const index = new PlaceIndex(cities, new Uint8Array(32400));
    expect(index.describe(-17, -179.9).name).toContain('Edge East');
  });

  it('falls back to ocean or remote land', () => {
    expect(new PlaceIndex(cities, new Uint8Array(32400)).describe(0, -150)).toMatchObject({
      kind: 'ocean',
      name: 'Open ocean',
    });
    expect(new PlaceIndex(cities, landOnlyAt(70, 100)).describe(69.9, 100.1)).toMatchObject({
      kind: 'remote',
      name: 'Remote area',
    });
  });
});

describe('land data', () => {
  const grid = new Uint8Array(readFileSync('public/data/land-grid.bin'));
  const index = new PlaceIndex([['Nowhere', 'AQ', -89, 0, 15000]], grid);

  it.each([
    ['United States', 40, -100], ['Paris', 48.85, 2.35], ['Antarctica', -80, 0], ['South Pole', -89.9, 0],
    ['Chukotka east', 66, 179], ['Chukotka west', 66, -175], ['Greenland', 72, -40], ['Australia', -25, 135],
    ['Sahara', 23, 10],
  ])('%s is land', (_name, lat, lon) => {
    expect(index.isLand(lat, lon)).toBe(true);
  });

  it.each([
    ['Pacific', 0, -150], ['Null Island', 0, 0], ['Atlantic', 30, -40], ['Arctic', 85, 0], ['Indian Ocean', -20, 75],
  ])('%s is water', (_name, lat, lon) => {
    expect(index.isLand(lat, lon)).toBe(false);
  });

  it.each([FREQUENCY_HIGH, FREQUENCY_LOW])('mask for frequency %i matches the mesh and places land correctly', (frequency) => {
    const mask = new Uint8Array(readFileSync(`public/data/land-mask-${frequency}.bin`));
    const { vertices, faces } = buildIcosphere(frequency);
    expect(faces.length / 3).toBe(faceCount(frequency));
    expect(mask.length).toBe(Math.ceil(faceCount(frequency) / 8));

    const faceAt = (lat: number, lon: number) => {
      const [px, py, pz] = latLonToVec3(lat, lon);
      let best = 0;
      let bestDot = -2;
      for (let f = 0; f < faces.length / 3; f++) {
        let dot = 0;
        for (let c = 0; c < 3; c++) {
          const v = faces[f * 3 + c] * 3;
          dot += vertices[v] * px + vertices[v + 1] * py + vertices[v + 2] * pz;
        }
        if (dot > bestDot) {
          bestDot = dot;
          best = f;
        }
      }
      return (mask[best >> 3] & (1 << (best & 7))) !== 0;
    };

    expect(faceAt(40, -100)).toBe(true);
    expect(faceAt(-25, 135)).toBe(true);
    expect(faceAt(66, 179.5)).toBe(true);
    expect(faceAt(0, -150)).toBe(false);
    expect(faceAt(30, -40)).toBe(false);
  });

  it('builds an outward-facing mesh with one corner set per face', () => {
    const mask = new Uint8Array(readFileSync(`public/data/land-mask-${FREQUENCY_LOW}.bin`));
    const { positions, normals, colors } = buildEarthArrays(FREQUENCY_LOW, mask);
    const corners = faceCount(FREQUENCY_LOW) * 3;
    expect(positions.length).toBe(corners * 3);
    expect(colors.length).toBe(corners * 3);
    for (let i = 0; i < positions.length; i += 9) {
      const outward = positions[i] * normals[i] + positions[i + 1] * normals[i + 1] + positions[i + 2] * normals[i + 2];
      expect(outward).toBeGreaterThan(0);
    }
  });
});

describe('formatting', () => {
  it('converts temperatures without printing negative zero', () => {
    expect(formatTemperature(20, 'c')).toBe('20°');
    expect(formatTemperature(20, 'f')).toBe('68°');
    expect(formatTemperature(-0.2, 'c')).toBe('0°');
    expect(formatTemperature(-40, 'f')).toBe('-40°');
  });

  it('converts wind', () => {
    expect(formatWind(100, 'c')).toBe('100 km/h');
    expect(formatWind(100, 'f')).toBe('62 mph');
  });

  it('formats local wall-clock times', () => {
    expect(formatLocalTime('2026-11-04T06:05', false)).toBe('06:05');
    expect(formatLocalTime('2026-11-04T00:05', true)).toBe('12:05 AM');
    expect(formatLocalTime('2026-11-04T12:30', true)).toBe('12:30 PM');
    expect(formatLocalTime('2026-11-04T17:30', true)).toBe('5:30 PM');
    expect(formatLocalHour('2026-11-04T17:00', true)).toBe('5 PM');
    expect(formatLocalHour('2026-11-04T07:00', false)).toBe('07:00');
  });

  it('formats age', () => {
    expect(formatAge(10_000)).toBe('just now');
    expect(formatAge(5 * 60_000)).toBe('5 min ago');
    expect(formatAge(2 * 3_600_000)).toBe('2 h ago');
  });
});

describe('shared links', () => {
  it('round-trips a view', () => {
    expect(parseHash(formatHash(22.5726, 88.3639, 1.8))).toEqual({ lat: 22.57, lon: 88.36, distance: 1.8 });
  });

  it('rejects invalid input', () => {
    for (const hash of ['', '#', '#abc', '#91,0', '#0,181', '#1,2,0.5', '#1,2,3,4', '#1,2,x']) {
      expect(parseHash(hash)).toBeNull();
    }
    expect(parseHash('#1,2')).toEqual({ lat: 1, lon: 2 });
  });
});

describe('cache', () => {
  it('expires by time but keeps stale values readable', () => {
    let now = 0;
    const cache = new TtlCache<string>(100, 10, () => now);
    cache.set('a', 'value');
    expect(cache.isFresh(cache.get('a')!)).toBe(true);
    now = 100;
    expect(cache.isFresh(cache.get('a')!)).toBe(false);
    expect(cache.get('a')!.value).toBe('value');
  });

  it('evicts the least recently used entry', () => {
    const cache = new TtlCache<number>(1000, 2);
    cache.set('a', 1);
    cache.set('b', 2);
    cache.get('a');
    cache.set('c', 3);
    expect(cache.get('a')).toBeDefined();
    expect(cache.get('b')).toBeUndefined();
  });

  it('snaps to 0.25° cells and wraps at the antimeridian', () => {
    expect(snapToCell(22.57, 88.36)).toMatchObject({ lat: 22.5, lon: 88.25, key: '22.5,88.25' });
    expect(snapToCell(10, 179.99).key).toBe(snapToCell(10, -179.99).key);
  });
});

const forecastNamed = (timezone: string): Forecast => ({
  timezone,
  current: { time: '2026-11-04T12:00', temp: 20, feelsLike: 19, humidity: 50, wind: 10, code: 0, isDay: true },
  hourly: [],
  sunrise: null,
  sunset: null,
});

function deferredFetcher() {
  const calls: Array<{
    lat: number;
    lon: number;
    signal: AbortSignal;
    resolve: (forecast: Forecast) => void;
    reject: (error: Error) => void;
  }> = [];
  const fetcher = (lat: number, lon: number, signal: AbortSignal) =>
    new Promise<Forecast>((resolve, reject) => {
      calls.push({ lat, lon, signal, resolve, reject });
    });
  return { calls, fetcher };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('forecast loader', () => {
  it('never lets a superseded response overwrite a newer one', async () => {
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s));

    loader.select(10, 10);
    loader.select(20, 20);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].signal.aborted).toBe(false);

    calls[1].resolve(forecastNamed('new'));
    await settle();
    // The old request ignored its abort and answers late.
    calls[0].resolve(forecastNamed('old'));
    await settle();

    const last = states.at(-1)!;
    expect(last.key).toBe('20,20');
    expect(last.data?.timezone).toBe('new');
  });

  it('ignores errors from aborted requests', async () => {
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s));
    loader.select(10, 10);
    loader.select(20, 20);
    calls[0].reject(new Error('aborted'));
    await settle();
    expect(states.some((s) => s.status === 'error')).toBe(false);
  });

  it('serves fresh data from cache without a request, then refetches after 15 minutes', async () => {
    let now = 1_000;
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s), { now: () => now });

    loader.select(10, 10);
    calls[0].resolve(forecastNamed('a'));
    await settle();
    loader.select(20, 20);
    calls[1].resolve(forecastNamed('b'));
    await settle();

    loader.select(10, 10);
    expect(calls.length).toBe(2);
    expect(states.at(-1)).toMatchObject({ status: 'ready', key: '10,10' });

    now += 15 * 60_000;
    loader.refreshIfExpired();
    expect(calls.length).toBe(3);
    // The old value stays on screen while refreshing.
    expect(states.at(-1)).toMatchObject({ status: 'loading' });
    expect(states.at(-1)?.data?.timezone).toBe('a');
  });

  it('keeps stale data on failure and backs off exponentially', async () => {
    let now = 0;
    const { calls, fetcher } = deferredFetcher();
    const states: ForecastState[] = [];
    const timers: Array<{ callback: () => void; ms: number }> = [];
    const loader = new ForecastLoader(fetcher, (s) => states.push(s), {
      now: () => now,
      setTimer: (callback, ms) => {
        timers.push({ callback, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });

    loader.select(10, 10);
    calls[0].resolve(forecastNamed('a'));
    await settle();

    now += 15 * 60_000;
    loader.refreshIfExpired();
    calls[1].reject(new Error('HTTP 429'));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'error' });
    expect(states.at(-1)?.data?.timezone).toBe('a');
    expect(timers[0].ms).toBe(5_000);

    timers[0].callback();
    calls[2].reject(new Error('HTTP 429'));
    await settle();
    expect(timers[1].ms).toBe(10_000);

    timers[1].callback();
    calls[3].resolve(forecastNamed('b'));
    await settle();
    expect(states.at(-1)).toMatchObject({ status: 'ready' });
    expect(states.at(-1)?.data?.timezone).toBe('b');
  });

  it('does not refetch while a request for the same cell is running', () => {
    const { calls, fetcher } = deferredFetcher();
    const loader = new ForecastLoader(fetcher, () => {});
    loader.select(10, 10);
    loader.select(10.01, 10.01);
    expect(calls.length).toBe(1);
  });
});

describe('forecast parsing', () => {
  const raw = {
    timezone: 'Asia/Kolkata',
    current: {
      time: '2026-11-04T13:15',
      temperature_2m: 30.2,
      apparent_temperature: 33,
      relative_humidity_2m: 60,
      wind_speed_10m: 8,
      weather_code: 2,
      is_day: 1,
    },
    hourly: {
      time: Array.from({ length: 48 }, (_, i) => {
        const day = i < 24 ? '04' : '05';
        return `2026-11-${day}T${String(i % 24).padStart(2, '0')}:00`;
      }),
      temperature_2m: Array.from({ length: 48 }, (_, i) => i),
      weather_code: Array.from({ length: 48 }, () => 1),
      is_day: Array.from({ length: 48 }, (_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
    },
    daily: {
      time: ['2026-11-04', '2026-11-05'],
      sunrise: ['2026-11-04T05:42', '2026-11-05T05:43'],
      sunset: ['2026-11-04T16:58', '2026-11-05T16:57'],
    },
  };

  it('starts the hourly strip at the current local hour', () => {
    const forecast = parseForecast(raw);
    expect(forecast.hourly).toHaveLength(12);
    expect(forecast.hourly[0].time).toBe('2026-11-04T13:00');
    expect(forecast.hourly[11].time).toBe('2026-11-05T00:00');
    expect(forecast.current.isDay).toBe(true);
    expect(forecast.sunrise).toBe('2026-11-04T05:42');
  });

  it('treats the identical midnight times of polar night as no sunrise', () => {
    const polar = parseForecast({
      ...raw,
      daily: { ...raw.daily, sunrise: ['2026-11-04T00:00', null], sunset: ['2026-11-04T00:00', null] },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });

  it('treats the midnight-to-midnight span of polar day as no sunrise', () => {
    const polar = parseForecast({
      ...raw,
      daily: { ...raw.daily, sunrise: ['2026-11-04T00:00', null], sunset: ['2026-11-05T00:00', null] },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });

  it('keeps a real sunset that falls just after midnight', () => {
    const late = parseForecast({
      ...raw,
      daily: { ...raw.daily, sunrise: ['2026-11-04T02:10', null], sunset: ['2026-11-05T00:20', null] },
    });
    expect(late.sunrise).toBe('2026-11-04T02:10');
    expect(late.sunset).toBe('2026-11-05T00:20');
  });

  it('treats a missing or wrong-day sunrise as none', () => {
    const polar = parseForecast({
      ...raw,
      daily: { ...raw.daily, sunrise: ['1970-01-01T00:00', null], sunset: [null, null] },
    });
    expect(polar.sunrise).toBeNull();
    expect(polar.sunset).toBeNull();
  });
});
