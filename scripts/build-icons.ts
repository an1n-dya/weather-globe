/** Renders public/icon.svg, and its full-bleed maskable version, to the PNG sizes the PWA manifest needs. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const publicDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public");

const jobs: Array<[source: string, size: number, output: string]> = [
  ["icon.svg", 192, "icon-192.png"],
  ["icon.svg", 512, "icon-512.png"],
  // Android crops maskable icons to a circle or squircle; the art keeps to the middle 80%.
  ["icon-maskable.svg", 512, "icon-maskable-512.png"],
];

const browser = await chromium.launch();
for (const [source, size, output] of jobs) {
  const svg = readFileSync(join(publicDir, source), "utf8");
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(publicDir, output), omitBackground: true });
  await page.close();
}
await browser.close();
