import { expect, test, type Page, type Route } from '@playwright/test';
import { mkdirSync } from 'node:fs';

const SHOTS = 'test-results/screens';
mkdirSync(SHOTS, { recursive: true });

interface ApiMock {
  forecastCalls: string[];
  mode: 'ok' | 'fail';
}

function forecastBody(url: URL) {
  const lat = Number(url.searchParams.get('latitude'));
  const zone = lat > 30 ? 'Asia/Tokyo' : 'Asia/Kolkata';
  const hours = Array.from({ length: 48 }, (_, i) => {
    const day = i < 24 ? '04' : '05';
    return `2026-11-${day}T${String(i % 24).padStart(2, '0')}:00`;
  });
  return {
    timezone: zone,
    current: {
      time: '2026-11-04T13:15',
      temperature_2m: 27.4,
      apparent_temperature: 29.1,
      relative_humidity_2m: 61,
      wind_speed_10m: 12,
      weather_code: 2,
      is_day: 1,
    },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => 20 + (i % 10)),
      weather_code: hours.map((_, i) => [0, 2, 3, 61, 95][i % 5]),
      is_day: hours.map((_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
    },
    daily: {
      time: ['2026-11-04', '2026-11-05'],
      sunrise: ['2026-11-04T05:42', '2026-11-05T05:43'],
      sunset: ['2026-11-04T16:58', '2026-11-05T16:57'],
    },
  };
}

async function mockApi(page: Page): Promise<ApiMock> {
  const mock: ApiMock = { forecastCalls: [], mode: 'ok' };
  await page.route('https://api.open-meteo.com/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const lats = (url.searchParams.get('latitude') ?? '').split(',');
    if (lats.length > 1) {
      const rows = lats.map((_, i) => ({
        current: { temperature_2m: 10 + (i % 25), weather_code: [0, 2, 3, 61, 71, 95][i % 6], is_day: i % 2 },
      }));
      await route.fulfill({ json: rows });
      return;
    }
    mock.forecastCalls.push(url.search);
    if (mock.mode === 'fail') {
      await route.fulfill({ status: 429, json: { error: true } });
      return;
    }
    await route.fulfill({ json: forecastBody(url) });
  });
  await page.route('https://geocoding-api.open-meteo.com/**', (route) =>
    route.fulfill({
      json: {
        results: [
          { id: 1, name: 'Kathmandu', admin1: 'Bagmati', country: 'Nepal', latitude: 27.7, longitude: 85.32 },
        ],
      },
    }),
  );
  return mock;
}

async function globeReady(page: Page) {
  await expect(page.getByTestId('place-name')).not.toHaveText('Locating…', { timeout: 20_000 });
  await expect(page.locator('.stage canvas')).toBeVisible();
}

async function dragGlobe(page: Page, dx: number, dy: number) {
  const box = (await page.locator('.stage canvas').boundingBox())!;
  const x = box.x + box.width * 0.35;
  const y = box.y + box.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
    await page.waitForTimeout(30);
  }
}

test('drag updates time and place without a network call, then weather loads on settling', async ({ page }, info) => {
  const mock = await mockApi(page);
  await page.goto('/#22.57,88.36');
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-1-loaded.png` });

  const coordsBefore = await page.getByTestId('coords').textContent();
  const callsBefore = mock.forecastCalls.length;

  await dragGlobe(page, 300, 80);
  await expect(page.getByTestId('coords')).not.toHaveText(coordsBefore!);
  expect(mock.forecastCalls.length, 'no weather request during a drag').toBe(callsBefore);
  await page.mouse.up();

  await expect.poll(() => mock.forecastCalls.length, { timeout: 15_000 }).toBeGreaterThan(callsBefore);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/#-?\d+\.\d+,-?\d+\.\d+,\d+\.\d+/);
});

test('the production security headers block nothing the app needs', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener('securitypolicyviolation', (event) => {
      (window as unknown as { violations: string[] }).violations.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  const response = await page.goto('/#35.68,139.69');
  expect(response?.headers()['content-security-policy']).toContain("default-src 'self'");
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Kath');
  await page.getByRole('option', { name: /Kathmandu/ }).click();
  await expect(page.getByTestId('place-name')).toHaveText('Kathmandu', { timeout: 20_000 });
  expect(await page.evaluate(() => (window as unknown as { violations: string[] }).violations)).toEqual([]);
});

test('the weather response replaces the estimated zone', async ({ page }) => {
  await mockApi(page);
  // Kolkata's estimate is +5:30; the mock reports Tokyo here to prove which one wins.
  await page.goto('/#35.68,139.69');
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('utc-offset')).toHaveText('UTC+9');
});

test('real offsets from the on-device estimate before weather arrives', async ({ page }) => {
  await page.route('https://api.open-meteo.com/**', (route) => route.abort());
  await page.goto('/#27.7,85.32');
  await globeReady(page);
  await expect(page.getByTestId('utc-offset')).toHaveText('UTC+5:45');
});

test('search flies to a place and uses its name', async ({ page }, info) => {
  await mockApi(page);
  await page.goto('/#0,-150');
  await globeReady(page);
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Kath');
  await page.getByRole('option', { name: /Kathmandu/ }).click();
  await expect(page.getByTestId('place-name')).toHaveText('Kathmandu', { timeout: 20_000 });
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('coords')).toContainText('27.7');
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-2-search.png` });
});

test('an API failure keeps time working and offers a retry', async ({ page }) => {
  const mock = await mockApi(page);
  mock.mode = 'fail';
  await page.goto('/#35.68,139.69');
  await globeReady(page);
  await expect(page.getByTestId('weather-error')).toBeVisible({ timeout: 20_000 });

  const first = await page.getByTestId('clock').textContent();
  await expect(page.getByTestId('clock')).not.toHaveText(first!, { timeout: 5_000 });

  mock.mode = 'ok';
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 10_000 });
});

test('a failed refresh shows the earlier weather with its age', async ({ page }) => {
  const mock = await mockApi(page);
  await page.clock.install();
  await page.goto('/#35.68,139.69');
  await page.clock.runFor(1_000);
  await globeReady(page);
  await page.clock.runFor(1_000);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });

  mock.mode = 'fail';
  // Past the 15-minute cache lifetime, plus one refresh check.
  await page.clock.fastForward(16 * 60_000);
  await page.clock.runFor(61_000);
  await expect(page.getByTestId('stale-note')).toBeAttached({ timeout: 20_000 });
  await expect(page.getByTestId('temperature')).toBeVisible();
});

test('a shared link restores the view', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#-33.87,151.21,1.80');
  await globeReady(page);
  await expect(page.getByTestId('coords')).toContainText('33.87°S 151.21°E');
  await expect(page.getByTestId('place-name')).toHaveText('Sydney');
  await page.reload();
  await globeReady(page);
  await expect(page.getByTestId('coords')).toContainText('33.87°S 151.21°E');
  await expect(page).toHaveURL(/1\.80$/);
});

test('crossing the antimeridian and reaching the poles keeps working', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#10.00,179.90,2.00');
  await globeReady(page);
  const stage = page.getByTestId('stage');
  await stage.focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press('ArrowRight');
  await expect(page.getByTestId('coords')).toContainText('°W', { timeout: 10_000 });

  await page.goto('/#89.00,0.00,3.00');
  await page.reload();
  await globeReady(page);
  await expect(page.getByTestId('coords')).toContainText('89.00°N');
  await expect(page.getByTestId('clock')).toHaveText(/\d/);
});

test('keyboard zoom and settings work', async ({ page, isMobile }, info) => {
  test.skip(isMobile, 'Physical keyboard only');
  await mockApi(page);
  await page.goto('/#51.50,-0.13,3.00');
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });

  await page.getByRole('button', { name: '°F' }).click();
  await expect(page.getByTestId('temperature')).toHaveText('81°');
  await page.getByRole('button', { name: '°C' }).click();
  await expect(page.getByTestId('temperature')).toHaveText('27°');

  await page.getByRole('button', { name: '24h' }).click();
  await expect(page.getByTestId('clock')).not.toHaveText(/AM|PM/i);
  await page.getByRole('button', { name: '12h' }).click();
  await expect(page.getByTestId('clock')).toHaveText(/AM|PM/i);

  await page.getByTestId('stage').focus();
  await page.keyboard.press('+');
  await page.keyboard.press('+');
  await page.waitForTimeout(1500);
  await expect(page).not.toHaveURL(/,3\.00$/);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-3-zoomed.png` });
});

test('tapping the globe flies there', async ({ page }) => {
  await mockApi(page);
  await page.goto('/#20.00,0.00');
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  const before = await page.getByTestId('coords').textContent();
  const box = (await page.locator('.reticle').boundingBox())!;
  // Well clear of the reticle, away from the panel and sheet.
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 + 60);
  await expect(page.getByTestId('coords')).not.toHaveText(before!, { timeout: 10_000 });
});

test('opening in a hidden window starts correctly once it is shown', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockApi(page);
  // Present from the first paint, as if the window had no size when the app started.
  await page.route(
    (url) => url.pathname === '/',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        '</head>',
        '<style id="hide-stage">.stage { display: none; }</style></head>',
      );
      await route.fulfill({ response, body });
    },
  );
  await page.goto('/#35.68,139.69');
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  await expect(page.getByTestId('coords')).toContainText('35.68°N 139.69°E');

  await page.evaluate(() => document.getElementById('hide-stage')?.remove());
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('coords')).toContainText('35.68°N 139.69°E');
  await expect(page.getByTestId('place-name')).toHaveText('Tokyo');
  expect(errors).toEqual([]);
});

test('the mobile sheet expands to show details', async ({ page, isMobile }, info) => {
  test.skip(!isMobile, 'Phone layout only');
  await mockApi(page);
  await page.goto('/#28.61,77.21');
  await globeReady(page);
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText('Humidity')).toBeHidden();
  await page.getByRole('button', { name: 'Show more' }).click();
  await expect(page.getByText('Humidity')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-4-expanded.png` });
});

test('without WebGL, search and the panel still work', async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto('/#0,0');
  await expect(page.getByRole('heading', { name: /3D globe can't run/ })).toBeVisible();
  await page.getByRole('combobox', { name: 'Search for a place' }).fill('Kath');
  await page.getByRole('option', { name: /Kathmandu/ }).click();
  await expect(page.getByTestId('place-name')).toHaveText('Kathmandu');
  await expect(page.getByTestId('temperature')).toBeVisible({ timeout: 10_000 });
});
