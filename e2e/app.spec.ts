import { mkdirSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Route, test } from "@playwright/test";

const SHOTS = "test-results/screens";
mkdirSync(SHOTS, { recursive: true });

interface ApiMock {
  forecastCalls: string[];
  mode: "ok" | "fail";
  /** How long the forecast takes to answer. */
  delayMs: number;
}

function forecastBody(url: URL) {
  const lat = Number(url.searchParams.get("latitude"));
  const zone = lat > 30 ? "Asia/Tokyo" : "Asia/Kolkata";
  const hours = Array.from({ length: 48 }, (_, i) => {
    const day = i < 24 ? "04" : "05";
    return `2026-11-${day}T${String(i % 24).padStart(2, "0")}:00`;
  });
  return {
    timezone: zone,
    current: {
      time: "2026-11-04T13:15",
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
      time: ["2026-11-04", "2026-11-05"],
      sunrise: ["2026-11-04T05:42", "2026-11-05T05:43"],
      sunset: ["2026-11-04T16:58", "2026-11-05T16:57"],
    },
  };
}

async function mockApi(page: Page): Promise<ApiMock> {
  const mock: ApiMock = { forecastCalls: [], mode: "ok", delayMs: 0 };
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
      await route.fulfill({ status: 429, json: { error: true } });
      return;
    }
    await route.fulfill({ json: forecastBody(url) });
  });
  await page.route("https://geocoding-api.open-meteo.com/**", (route) =>
    route.fulfill({
      json: {
        results: [
          {
            id: 1,
            name: "Kathmandu",
            admin1: "Bagmati",
            country: "Nepal",
            latitude: 27.7,
            longitude: 85.32,
          },
        ],
      },
    }),
  );
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

test("the mobile sheet expands to show details", async ({ page, isMobile }, info) => {
  test.skip(!isMobile, "Phone layout only");
  await mockApi(page);
  await page.goto("/#28.61,77.21");
  await globeReady(page);
  await expect(page.getByTestId("temperature")).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText("Humidity")).toBeHidden();
  await page.getByRole("button", { name: "Show more" }).click();
  await expect(page.getByText("Humidity")).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/${info.project.name}-4-expanded.png` });
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
  // Long enough for the mesh and night lights to finish loading.
  await page.waitForTimeout(1500);

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
  if (info.project.name === "mobile") await page.getByRole("button", { name: "Show more" }).click();

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
