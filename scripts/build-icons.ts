/** Renders public/icon.svg to the PNG sizes the PWA manifest needs. */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(join(publicDir, 'icon.svg'), 'utf8');

const browser = await chromium.launch();
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
  );
  await page.screenshot({ path: join(publicDir, `icon-${size}.png`), omitBackground: true });
  await page.close();
}
await browser.close();
