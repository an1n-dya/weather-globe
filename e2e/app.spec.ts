import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";

const SHOTS = "test-results/screens";
mkdirSync(SHOTS, { recursive: true });

interface ApiMock {
  forecastCalls: string[];
  mode: "ok" | "fail" | "busy";
  /** How long the forecast takes to answer. */
  delayMs: number;
  /** Daily sunrise and sunset values to answer with, as Open-Meteo would. */
  sun: { sunrise: string[]; sunset: string[] } | null;
  /** How long a search takes to answer. */
  searchDelayMs: number;
}

function forecastBody(url: URL, sun: ApiMock["sun"]) {
  const lat = Number(url.searchParams.get("latitude"));
  const lon = Number(url.searchParams.get("longitude"));
  const nearKathmandu = Math.abs(lat - 27.7) < 1 && Math.abs(lon - 85.3) < 1;
  const zone = lat > 30 ? "Asia/Tokyo" : nearKathmandu ? "Asia/Kathmandu" : "Asia/Kolkata";
  const hours = Array.from({ length: 7 * 24 }, (_, i) => {
    const day = String(4 + Math.floor(i / 24)).padStart(2, "0");
    return `2026-11-${day}T${String(i % 24).padStart(2, "0")}:00`;
  });
  const days = Array.from({ length: 7 }, (_, i) => `2026-11-${String(4 + i).padStart(2, "0")}`);
  return {
    timezone: zone,
    current: {
      time: "2026-11-04T13:15",
      temperature_2m: 27.4,
      apparent_temperature: 29.1,
      relative_humidity_2m: 61,
      dew_point_2m: 19.2,
      wind_speed_10m: 12,
      wind_direction_10m: 225,
      wind_gusts_10m: 30,
      weather_code: 2,
      is_day: 1,
      pressure_msl: 1012.6,
      cloud_cover: 40,
      visibility: 24_000,
      uv_index: 6.2,
    },
    hourly: {
      time: hours,
      temperature_2m: hours.map((_, i) => 20 + (i % 10)),
      weather_code: hours.map((_, i) => [0, 2, 3, 61, 95][i % 5]),
      is_day: hours.map((_, i) => (i % 24 >= 6 && i % 24 < 18 ? 1 : 0)),
      precipitation_probability: hours.map((_, i) => (i * 7) % 100),
    },
    daily: {
      time: days,
      weather_code: days.map((_, i) => [1, 61, 3, 0, 95, 2, 71][i]),
      temperature_2m_max: days.map((_, i) => 30 - i),
      temperature_2m_min: days.map((_, i) => 20 - i),
      precipitation_probability_max: days.map((_, i) => i * 12),
      uv_index_max: days.map(() => 7),
      daylight_duration: days.map(() => 40_000),
      sunrise: sun?.sunrise ?? days.map((d) => `${d}T05:42`),
      sunset: sun?.sunset ?? days.map((d) => `${d}T16:58`),
    },
  };
}

async function mockApi(page: Page): Promise<ApiMock> {
  const mock: ApiMock = {
    forecastCalls: [],
    mode: "ok",
    delayMs: 0,
    sun: null,
    searchDelayMs: 0,
  };
  await page.route("https://api.open-meteo.com/**", async (route: Route) => {
    const url = new URL(route.request().url());
    const lats = (url.searchParams.get("latitude") ?? "").split(",");
    if (lats.length > 1) {
      const rows = lats.map((_, i) => ({
        current: {
          temperature_2m: 10 + (i % 25),
          weather_code: [0, 2, 3, 61, 71, 95][i % 6],
          is_day: i % 2,
        },
      }));
      await route.fulfill({ json: rows });
      return;
    }
    mock.forecastCalls.push(url.search);
    if (mock.delayMs) await new Promise((resolve) => setTimeout(resolve, mock.delayMs));
    if (mock.mode === "fail") {
      await route.fulfill({ status: 500, json: { error: true } });
      return;
    }
    if (mock.mode === "busy") {
      await route.fulfill({ status: 429, headers: { "Retry-After": "30" }, json: { error: true } });
      return;
    }
    await route.fulfill({ json: forecastBody(url, mock.sun) });
  });
  await page.route("https://geocoding-api.open-meteo.com/**", async (route) => {
    if (mock.searchDelayMs) await new Promise((resolve) => setTimeout(resolve, mock.searchDelayMs));
    await route.fulfill({
      json: {
        results: [
          {
            id: 1,
            name: "Kathmandu",
            admin1: "Bagmati",
            country: "Nepal",
            country_code: "NP",
            timezone: "Asia/Kathmandu",
            latitude: 27.7,
            longitude: 85.32,
          },
        ],
      },
    });
  });
  return mock;
}

async function globeReady(page: Page) {
  await expect(page.getByTestId("place-name")).not.toHaveText("Locating…", { timeout: 20_000 });
  await expect(page.locator(".stage canvas")).toBeVisible();
}

async function dragGlobe(page: Page, dx: number, dy: number) {
  const box = await page.locator(".stage canvas").boundingBox();
  if (!box) throw new Error("The globe has no size");
  const x = box.x + box.width * 0.35;
  const y = box.y + box.height * 0.4;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) {
    await page.mouse.move(x + (dx * i) / 6, y + (dy * i) / 6);
    await page.waitForTimeout(30);
  }
}

test("drag updates time and place without a network call, then weather loads on settling", async ({
  page,
}, info) => {
  const mock = await mockApi(page);
  await page.goto("/#22.57,88.36");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-1-loaded.png` });

  const coordsBefore = await page.getByTestId("coords").textContent();
  const callsBefore = mock.forecastCalls.length;

  await dragGlobe(page, 300, 80);
  await expect(page.getByTestId("coords")).not.toHaveText(coordsBefore ?? "");
  expect(mock.forecastCalls.length, "no weather request during a drag").toBe(callsBefore);
  await page.mouse.up();

  await expect
    .poll(() => mock.forecastCalls.length, { timeout: 15_000 })
    .toBeGreaterThan(callsBefore);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 15_000 });
  await expect(page).toHaveURL(/#-?\d+\.\d+,-?\d+\.\d+,\d+\.\d+/);
});

test("the production security headers block nothing the app needs", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    (window as unknown as { violations: string[] }).violations = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { violations: string[] }).violations.push(
        `${event.violatedDirective} ${event.blockedURI}`,
      );
    });
  });
  const response = await page.goto("/#35.68,139.69");
  expect(response?.headers()["content-security-policy"]).toContain("default-src 'self'");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await page.getByRole("combobox", { name: "Search for a place" }).fill("Kath");
  await page.getByRole("option", { name: /Kathmandu/ }).click();
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu", { timeout: 20_000 });
  expect(
    await page.evaluate(() => (window as unknown as { violations: string[] }).violations),
  ).toEqual([]);
});

test("the weather response replaces the estimated zone", async ({ page }) => {
  await mockApi(page);
  // Kolkata's estimate is +5:30; the mock reports Tokyo here to prove which one wins.
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("utc-offset")).toHaveText("UTC+9");
});

test("the on-device estimate gives the right offset before weather arrives", async ({ page }) => {
  await page.route("https://api.open-meteo.com/**", (route) => route.abort());
  await page.goto("/#27.7,85.32");
  await globeReady(page);
  await expect(page.getByTestId("utc-offset")).toHaveText("UTC+5:45");
});

test("search flies to a place and uses its name", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/#0,-150");
  await globeReady(page);
  await page.getByRole("combobox", { name: "Search for a place" }).fill("Kath");
  await page.getByRole("option", { name: /Kathmandu/ }).click();
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu", { timeout: 20_000 });
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("coords")).toContainText("27.7");
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-2-search.png` });
});

test("an API failure keeps time working and offers a retry", async ({ page }) => {
  const mock = await mockApi(page);
  mock.mode = "fail";
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("weather-error")).toBeVisible({ timeout: 20_000 });

  const first = await page.getByTestId("clock").textContent();
  await expect(page.getByTestId("clock")).not.toHaveText(first ?? "", { timeout: 5_000 });

  mock.mode = "ok";
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 10_000 });
});

test("a failed refresh shows the earlier weather with its age", async ({ page }) => {
  const mock = await mockApi(page);
  await page.clock.install();
  await page.goto("/#35.68,139.69");
  await page.clock.runFor(1_000);
  await globeReady(page);
  await page.clock.runFor(1_000);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });

  mock.mode = "fail";
  // Past the 15-minute cache lifetime. Skipping ahead fires the refresh check once.
  await page.clock.fastForward(16 * 60_000);
  await expect(page.getByTestId("stale-note")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("temperature")).toBeVisible();
});

test("a shared link restores the view", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#-33.87,151.21,1.80");
  await globeReady(page);
  await expect(page.getByTestId("coords")).toContainText("33.87°S 151.21°E");
  await expect(page.getByTestId("place-name")).toHaveText("Sydney");
  await page.reload();
  await globeReady(page);
  await expect(page.getByTestId("coords")).toContainText("33.87°S 151.21°E");
  await expect(page).toHaveURL(/1\.80$/);
});

test("crossing the antimeridian and reaching the poles keeps working", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#10.00,179.90,2.00");
  await globeReady(page);
  await page.locator(".stage canvas").focus();
  for (let i = 0; i < 4; i++) await page.keyboard.press("ArrowRight");
  await expect(page.getByTestId("coords")).toContainText("°W", { timeout: 10_000 });

  await page.goto("/#89.00,0.00,3.00");
  await page.reload();
  await globeReady(page);
  await expect(page.getByTestId("coords")).toContainText("89.00°N");
  await expect(page.getByTestId("clock")).toHaveText(/\d/);
});

test("keyboard zoom and settings work", async ({ page, isMobile }, info) => {
  test.skip(isMobile, "Physical keyboard only");
  await mockApi(page);
  await page.goto("/#51.50,-0.13,3.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "°F" }).click();
  await expect(page.getByTestId("temperature")).toHaveText("81°");
  await page.getByRole("button", { name: "°C" }).click();
  await expect(page.getByTestId("temperature")).toHaveText("27°");

  await page.getByRole("button", { name: "24h" }).click();
  await expect(page.getByTestId("clock")).not.toHaveText(/AM|PM/i);
  await page.getByRole("button", { name: "12h" }).click();
  await expect(page.getByTestId("clock")).toHaveText(/AM|PM/i);

  await page.locator(".stage canvas").focus();
  await page.keyboard.press("+");
  await page.keyboard.press("+");
  await page.waitForTimeout(1500);
  await expect(page).not.toHaveURL(/,3\.00$/);
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-3-zoomed.png` });
});

test("tapping the globe flies there", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  const before = await page.getByTestId("coords").textContent();
  const box = await page.locator(".reticle").boundingBox();
  if (!box) throw new Error("The reticle has no size");
  // Well clear of the reticle, away from the panel and sheet.
  await page.mouse.click(box.x + box.width / 2 + 60, box.y + box.height / 2 + 60);
  await expect(page.getByTestId("coords")).not.toHaveText(before ?? "", { timeout: 10_000 });
});

test("opening in a hidden window starts correctly once it is shown", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await mockApi(page);
  // Present from the first paint, as if the window had no size when the app started.
  await page.route(
    (url) => url.pathname === "/",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace(
        "</head>",
        '<style id="hide-stage">.stage { display: none; }</style></head>',
      );
      await route.fulfill({ response, body });
    },
  );
  await page.goto("/#35.68,139.69");
  await page.waitForTimeout(500);
  expect(errors).toEqual([]);
  await expect(page.getByTestId("coords")).toContainText("35.68°N 139.69°E");

  await page.evaluate(() => document.getElementById("hide-stage")?.remove());
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId("coords")).toContainText("35.68°N 139.69°E");
  await expect(page.getByTestId("place-name")).toHaveText("Tokyo");
  expect(errors).toEqual([]);
});

test("the mobile sheet steps from collapsed to half to full and back", async ({
  page,
  isMobile,
}, info) => {
  test.skip(!isMobile, "Phone layout only");
  await mockApi(page);
  await page.goto("/#28.61,77.21");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  const panel = page.locator(".panel");
  await expect(panel).toHaveAttribute("data-sheet", "collapsed");
  await expect(page.getByText("Humidity")).toBeHidden();

  await page.getByRole("button", { name: "Show more" }).click();
  await expect(panel).toHaveAttribute("data-sheet", "half");
  await expect(page.getByText("Humidity")).toBeVisible();
  // The globe moves up to stay in view above the sheet.
  const reticle = await page.locator(".reticle").boundingBox();
  const sheetTop = (await panel.boundingBox())?.y ?? 0;
  await expect
    .poll(async () => (await page.locator(".reticle").boundingBox())?.y ?? 0)
    .toBeLessThan(sheetTop);
  expect(reticle).not.toBeNull();

  await page.getByRole("button", { name: "Show more" }).click();
  await expect(panel).toHaveAttribute("data-sheet", "full");
  await expect(page.locator(".map-controls")).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-4-expanded.png` });
  await page.getByRole("button", { name: "Show less" }).click();
  await expect(panel).toHaveAttribute("data-sheet", "collapsed");
});

test("dragging the sheet handle up opens it", async ({ page, isMobile }) => {
  test.skip(!isMobile, "Phone layout only");
  await mockApi(page);
  await page.goto("/#28.61,77.21");
  await globeReady(page);
  const handle = page.locator(".sheet-handle");
  const box = await handle.boundingBox();
  if (!box) throw new Error("No sheet handle");
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(x, y - i * 40);
  await page.mouse.up();
  await expect(page.locator(".panel")).not.toHaveAttribute("data-sheet", "collapsed");
});

test("without WebGL, search and the panel still work", async ({ page }) => {
  await mockApi(page);
  await page.addInitScript(() => {
    HTMLCanvasElement.prototype.getContext = (() =>
      null) as typeof HTMLCanvasElement.prototype.getContext;
  });
  await page.goto("/#0,0");
  await expect(page.getByRole("heading", { name: /3D globe couldn't start/ })).toBeVisible();
  // Weather for the starting place loads with no globe to settle.
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 10_000 });
  await page.getByRole("combobox", { name: "Search for a place" }).fill("Kath");
  await page.getByRole("option", { name: /Kathmandu/ }).click();
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu");
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 10_000 });
});

test.describe("in a locale with a 24-hour clock", () => {
  test.use({ locale: "en-GB" });

  test("hours are padded, matching the hourly strip", async ({ page }) => {
    await mockApi(page);
    await page.clock.setFixedTime(new Date("2026-11-04T00:05:09Z"));
    await page.goto("/#35.68,139.69");
    await expect(page.getByTestId("utc-offset")).toHaveText("UTC+9");
    await expect(page.getByTestId("clock")).toHaveText("09:05:09");
  });
});

test("the first load never says to stop moving", async ({ page }) => {
  // Slow enough that the globe appears while the weather is still on its way.
  const mock = await mockApi(page);
  mock.delayMs = 2_500;
  const seen: string[] = [];
  await page.exposeFunction("reportPending", (text: string) => seen.push(text));
  await page.addInitScript(() => {
    const check = () => {
      const pending = document.querySelector('[data-testid="weather-pending"]');
      if (pending?.textContent)
        (window as unknown as { reportPending(text: string): void }).reportPending(
          pending.textContent,
        );
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await page.goto("/");
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  expect(seen.filter((text) => text.includes("Stop"))).toEqual([]);
});

test("a right-click does not fly anywhere", async ({ page, isMobile }) => {
  test.skip(isMobile, "Mouse only");
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  const before = await page.getByTestId("coords").textContent();
  const box = await page.locator(".reticle").boundingBox();
  if (!box) throw new Error("The reticle has no size");
  await page.mouse.click(box.x + 80, box.y + 80, { button: "right" });
  await page.waitForTimeout(800);
  expect(await page.getByTestId("coords").textContent()).toBe(before);
});

test("browser shortcuts stay with the browser", async ({ page, isMobile }) => {
  test.skip(isMobile, "Physical keyboard only");
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  const canvas = page.locator(".stage canvas");
  await canvas.focus();
  const prevented = await canvas.evaluate((element) => {
    const press = (init: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
      element.dispatchEvent(event);
      return event.defaultPrevented;
    };
    return {
      ctrlMinus: press({ key: "-", ctrlKey: true }),
      altLeft: press({ key: "ArrowLeft", altKey: true }),
      plainLeft: press({ key: "ArrowLeft" }),
    };
  });
  expect(prevented).toEqual({ ctrlMinus: false, altLeft: false, plainLeft: true });
});

test("the globe redraws after the graphics context is lost and restored", async ({ page }) => {
  // Chromium keeps showing the last frame after a simulated loss, so a screenshot
  // can't tell whether a redraw happened. Counting draw calls can.
  await page.addInitScript(() => {
    const counter = window as unknown as { draws: number };
    counter.draws = 0;
    const prototype = WebGL2RenderingContext.prototype as unknown as Record<
      string,
      (...args: unknown[]) => unknown
    >;
    for (const method of ["drawArrays", "drawElements"]) {
      const original = prototype[method];
      if (!original) continue;
      prototype[method] = function (this: unknown, ...args: unknown[]) {
        counter.draws++;
        return original.apply(this, args);
      };
    }
  });
  const draws = () => page.evaluate(() => (window as unknown as { draws: number }).draws);

  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  // The full globe has faded in, and the night lights have had time to arrive.
  await expect(page.getByTestId("stage")).toHaveAttribute("data-globe", "ready", {
    timeout: 30_000,
  });
  await page.waitForTimeout(800);

  // An idle globe draws nothing, so any increase below comes from the restore.
  const before = await draws();
  await page.waitForTimeout(300);
  expect(await draws()).toBe(before);

  await page.locator(".stage canvas").evaluate(async (element) => {
    const gl = (element as HTMLCanvasElement).getContext("webgl2");
    const extension = gl?.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("This browser cannot simulate a lost context");
    await new Promise((resolve) => {
      element.addEventListener("webglcontextlost", resolve, { once: true });
      extension.loseContext();
    });
    // Restoring is only allowed once the browser has finished handling the loss.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await new Promise((resolve) => {
      element.addEventListener("webglcontextrestored", resolve, { once: true });
      extension.restoreContext();
    });
  });

  await expect.poll(draws, { timeout: 3_000 }).toBeGreaterThan(before);
});

test("coming back online fetches the weather straight away", async ({ page, context }) => {
  const mock = await mockApi(page);
  mock.mode = "fail";
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("weather-error")).toBeVisible({ timeout: 20_000 });

  mock.mode = "ok";
  await context.setOffline(true);
  await context.setOffline(false);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 4_000 });
});

/** Names of shown markers overlapping the search box or the map buttons. */
function markersOverInterface(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const obstacles = [...document.querySelectorAll(".search, .map-controls")].map((element) =>
      element.getBoundingClientRect(),
    );
    return [...document.querySelectorAll(".city-marker.is-shown .city-marker-body")]
      .filter((body) => {
        const box = body.getBoundingClientRect();
        return obstacles.some(
          (o) =>
            box.left < o.right && box.right > o.left && box.top < o.bottom && box.bottom > o.top,
        );
      })
      .map((body) => body.textContent ?? "");
  });
}

test("markers stay clear of the search box and buttons", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  expect(await page.locator(".city-marker.is-shown").count()).toBeGreaterThan(3);
  expect(await markersOverInterface(page)).toEqual([]);
});

test("a sideways phone keeps a usable globe", async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 667, height: 375 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await context.newPage();
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);

  // The hash records the fitted camera distance: under 6 means the globe fills the free height.
  const distance = Number(new URL(page.url()).hash.split(",")[2]);
  expect(distance).toBeLessThan(6);

  const search = await page.locator(".search").boundingBox();
  const panel = await page.locator(".panel").boundingBox();
  if (!search || !panel) throw new Error("Layout is missing a part");
  expect(search.x + search.width).toBeLessThanOrEqual(panel.x);
  expect(await markersOverInterface(page)).toEqual([]);
  await page.screenshot({ path: `${SHOTS}/landscape-phone.png` });
  await context.close();
});

test("there are no accessibility violations", async ({ page }, info) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  if (info.project.name === "mobile" || info.project.name === "iphone") {
    await page.getByRole("button", { name: "Show more" }).click();
    await page.getByRole("button", { name: "Show more" }).click();
  }

  const results = await new AxeBuilder({ page }).analyze();
  const summary = results.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
  );
  expect(summary).toEqual([]);

  // Search results are only in the page while open.
  await page.getByRole("combobox", { name: "Search for a place" }).fill("Kath");
  await expect(page.getByRole("option", { name: /Kathmandu/ })).toBeVisible();
  const open = await new AxeBuilder({ page }).include(".search").analyze();
  expect(open.violations.map((v) => v.id)).toEqual([]);
});

test("open water and lakes are named, not just called open ocean", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#30.00,-40.00");
  await globeReady(page);
  await expect(page.getByTestId("place-name")).toHaveText("North Atlantic Ocean");
  await page.goto("/#47.70,-87.50,2.00");
  await page.reload();
  await globeReady(page);
  await expect(page.getByTestId("place-name")).toHaveText("Lake Superior");
});

test("polar night says so instead of showing no sunrise", async ({ page }) => {
  const mock = await mockApi(page);
  // What Open-Meteo reports when the sun doesn't rise: midnight for both.
  mock.sun = { sunrise: ["2026-11-04T00:00", null], sunset: ["2026-11-04T00:00", null] } as never;
  await page.clock.setFixedTime(new Date("2026-12-10T12:00:00Z"));
  await page.goto("/#80.00,20.00");
  await expect(page.getByTestId("polar")).toContainText("Polar night", { timeout: 20_000 });
});

test("the hourly strip shows whole hours and pages through the day", async ({ page, isMobile }) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  if (isMobile) await page.getByRole("button", { name: "Show more" }).click();
  const strip = page.getByRole("list", { name: "Next 24 hours" });
  await expect(strip.locator("li")).toHaveCount(24);
  const hourVisibility = async () =>
    strip.evaluate((list) => {
      const box = list.getBoundingClientRect();
      return [...list.querySelectorAll("li")].map((item) => {
        const r = item.getBoundingClientRect();
        if (r.right <= box.left + 1 || r.left >= box.right - 1) return "out";
        return r.left >= box.left - 1 && r.right <= box.right + 1 ? "whole" : "cut";
      });
    });
  const before = await hourVisibility();
  expect(before.filter((state) => state === "cut")).toEqual([]);
  expect(before.filter((state) => state === "whole").length).toBeGreaterThanOrEqual(5);
  await strip.evaluate((list) => list.scrollBy({ left: list.clientWidth }));
  await expect
    .poll(async () => (await hourVisibility()).slice(0, 6).every((state) => state === "out"))
    .toBe(true);
  expect((await hourVisibility()).filter((state) => state === "cut")).toEqual([]);
});

test("a rate-limited weather service says it's busy and when it will retry", async ({ page }) => {
  const mock = await mockApi(page);
  mock.mode = "busy";
  await page.goto("/#35.68,139.69");
  await expect(page.getByTestId("weather-error")).toContainText("busy", { timeout: 20_000 });
  await expect(page.getByTestId("weather-error")).toContainText(/Trying again in \d+ s/);
});

test("double-clicking the globe zooms in there", async ({ page, isMobile }) => {
  test.skip(isMobile, "Mouse only");
  await mockApi(page);
  await page.goto("/#20.00,0.00,3.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  const box = await page.locator(".reticle").boundingBox();
  if (!box) throw new Error("The reticle has no size");
  await page.mouse.dblclick(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30);
  await expect
    .poll(() => Number(new URL(page.url()).hash.split(",")[2]), { timeout: 10_000 })
    .toBeLessThan(2.2);
});

test("Enter picks the first result even before it arrives, and Escape clears", async ({ page }) => {
  const mock = await mockApi(page);
  mock.searchDelayMs = 800;
  await page.goto("/#0,-150");
  await globeReady(page);
  const search = page.getByRole("combobox", { name: "Search for a place" });
  await search.fill("Kathm");
  await search.press("Enter");
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu", { timeout: 20_000 });

  await search.fill("Somewhere");
  await search.press("Escape");
  await search.press("Escape");
  await expect(search).toHaveValue("");
});

test("the globe loads a light version first, then the full one", async ({ page, isMobile }) => {
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  const stage = page.getByTestId("stage");
  await expect(stage).toHaveAttribute("data-globe", "ready", { timeout: 30_000 });
  const faces = Number(await stage.getAttribute("data-faces"));
  // Desktops get the full globe; phones the medium one, or the light one when they
  // report few cores (as an emulated phone on a small test machine does).
  expect(faces).toBeGreaterThan(isMobile ? 25_000 : 150_000);

  await page.goto("/?detail=low#20.00,0.00");
  await expect(stage).toHaveAttribute("data-globe", "ready", { timeout: 30_000 });
  expect(Number(await stage.getAttribute("data-faces"))).toBeLessThan(40_000);
});

test("the panel shows the week, the conditions and the sun", async ({ page, isMobile }) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  if (isMobile) await page.getByRole("button", { name: "Show more" }).click();
  const week = page.getByRole("region", { name: "7-day forecast" });
  await expect(week.getByRole("listitem")).toHaveCount(7);
  await expect(week.getByRole("listitem").first()).toHaveAccessibleName(/^Today: Mainly clear/);
  const conditions = page.getByRole("region", { name: "Conditions" });
  await expect(conditions).toContainText("UV index");
  await expect(conditions).toContainText("High");
  await expect(conditions).toContainText("From the southwest");
  // 24 km, or 15 mi where the locale uses miles.
  await expect(conditions).toContainText(/24 km|15 mi/);
  await expect(page.getByRole("region", { name: "Sun" })).toContainText("Daylight");
  await expect(page.getByTestId("summary")).toContainText("partly cloudy");
});

test("wind units switch, and the choice survives a reload", async ({ page, isMobile }) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  if (isMobile) {
    await page.getByRole("button", { name: "Show more" }).click();
    await page.getByRole("button", { name: "Show more" }).click();
  }
  const conditions = page.getByRole("region", { name: "Conditions" });
  await page.getByRole("button", { name: "Meters per second" }).click();
  await expect(conditions).toContainText("3 m/s");
  await page.reload();
  await globeReady(page);
  if (isMobile) {
    await page.getByRole("button", { name: "Show more" }).click();
    await page.getByRole("button", { name: "Show more" }).click();
  }
  await expect(page.getByRole("button", { name: "Meters per second" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});

test("a saved place is listed in search, after a reload too", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("place-name")).toHaveText("Tokyo");
  await page.getByRole("button", { name: "Save this place" }).click();
  await expect(page.getByRole("button", { name: "Remove from saved places" })).toBeVisible();
  await page.reload();
  await globeReady(page);
  await page.getByRole("combobox", { name: "Search for a place" }).focus();
  const saved = page.getByRole("group", { name: "Saved places" });
  await expect(saved.getByRole("option", { name: /Tokyo/ })).toBeVisible();
});

test("searching remembers recent places", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#0,-150");
  await globeReady(page);
  const search = page.getByRole("combobox", { name: "Search for a place" });
  await search.fill("Kath");
  await expect(page.getByRole("option", { name: /Kathmandu.*Bagmati, Nepal/ })).toBeVisible();
  await page.getByRole("option", { name: /Kathmandu/ }).click();
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu", { timeout: 20_000 });
  await search.focus();
  await expect(
    page.getByRole("group", { name: "Recent" }).getByRole("option", { name: /Kathmandu/ }),
  ).toBeVisible();
});

test("compare shows how far apart two clocks are", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#35.68,139.69");
  await globeReady(page);
  await expect(page.getByTestId("place-name")).toHaveText("Tokyo");
  await page.getByRole("button", { name: "Compare with another place" }).click();
  await page.getByRole("combobox", { name: "Search for a place" }).fill("Kath");
  await page.getByRole("option", { name: /Kathmandu/ }).click();
  await expect(page.getByTestId("place-name")).toHaveText("Kathmandu", { timeout: 20_000 });
  await expect(page.getByTestId("compare-difference")).toHaveText(
    "Kathmandu is 3¼ hours behind Tokyo",
  );
  await page.getByRole("button", { name: "Stop comparing" }).first().click();
  await expect(page.getByTestId("compare")).toBeHidden();
});

test("the share button copies a link to this view", async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== "chromium" || isMobile, "Clipboard access in desktop Chromium");
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await mockApi(page);
  await page.goto("/#35.68,139.69,2.00");
  await globeReady(page);
  await page.getByRole("button", { name: "Share a link to this view" }).click();
  await expect(page.locator(".toast")).toHaveText("Link copied");
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toMatch(/#35\.68,139\.69,2\.00$/);
});

test("the slash key focuses search, and the home button shows the whole globe", async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, "Physical keyboard only");
  await mockApi(page);
  await page.goto("/#35.68,139.69,1.40");
  await globeReady(page);
  await page.locator("body").press("/");
  await expect(page.getByRole("combobox", { name: "Search for a place" })).toBeFocused();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Show the whole globe" }).click();
  await expect
    .poll(() => Number(new URL(page.url()).hash.split(",")[2]), { timeout: 10_000 })
    .toBeGreaterThan(2.5);
});

test("zoomed out, the badges stay few and apart", async ({ page }) => {
  await mockApi(page);
  await page.goto("/#20.00,0.00");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  const boxes = await page.evaluate(() =>
    [...document.querySelectorAll(".city-marker.is-shown .city-marker-body")].map((element) => {
      const r = element.getBoundingClientRect();
      return [r.left, r.top, r.right, r.bottom];
    }),
  );
  expect(boxes.length).toBeGreaterThan(3);
  expect(boxes.length).toBeLessThanOrEqual(16);
  const overlapping = boxes.flatMap(([l1 = 0, t1 = 0, r1 = 0, b1 = 0], i) =>
    boxes
      .slice(i + 1)
      .filter(([l2 = 0, t2 = 0, r2 = 0, b2 = 0]) => l1 < r2 && r1 > l2 && t1 < b2 && b1 > t2),
  );
  expect(overlapping).toEqual([]);
});

test("the globe's data downloads once, started as the app boots", async ({ page }) => {
  await mockApi(page);
  const downloads: string[] = [];
  page.on("request", (request) => {
    if (request.url().includes("/data/earth.bin")) downloads.push(request.url());
  });
  await page.goto("/#20.00,0.00");
  await expect(page.getByTestId("stage")).toHaveAttribute("data-globe", "ready", {
    timeout: 30_000,
  });
  expect(downloads).toHaveLength(1);
});
