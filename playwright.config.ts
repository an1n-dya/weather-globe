import { defineConfig, devices } from "@playwright/test";

/** Lets Chromium draw WebGL on machines with no usable graphics card. */
const SOFTWARE_WEBGL = ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
  use: {
    baseURL: "http://localhost:4173",
    serviceWorkers: "block",
  },
  webServer: {
    command: "npm run build && npm run preview -- --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: true,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1280, height: 800 },
        launchOptions: { args: SOFTWARE_WEBGL },
      },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"], launchOptions: { args: SOFTWARE_WEBGL } },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: { width: 1280, height: 800 } },
    },
    { name: "iphone", use: { ...devices["iPhone 14"] } },
  ],
});
