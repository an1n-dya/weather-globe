# Weather Globe

Spin a realistic globe to see the local time and live weather anywhere on Earth. The reticle marks the selected place: time updates as you drag, and weather loads when you stop. Clouds, rain, snow, fog and lightning follow current conditions around the world, under this month's satellite imagery, the real night lights, and the stars as they stand right now. Zoom in on a place where it's raining or snowing to see it fall.

The panel shows the local time, current conditions with an animated icon and backdrop, the next 24 hours with the chance of rain, and the week ahead. The cloud button beside the zoom controls hides the clouds and rain for a clear view of the ground.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Commands

| Command                   | What it does                                                                                                                                                                  |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`             | Dev server                                                                                                                                                                    |
| `npm run build`           | Type-check and build to `dist/` for any static host                                                                                                                           |
| `npm run preview`         | Serve the production build                                                                                                                                                    |
| `npm run lint`            | Check formatting and lint rules with Biome                                                                                                                                    |
| `npm run format`          | Fix formatting and safe lint issues                                                                                                                                           |
| `npm run typecheck`       | Type-check without building                                                                                                                                                   |
| `npm test`                | Unit tests                                                                                                                                                                    |
| `npm run e2e`             | Browser tests in Chromium, Firefox, and WebKit, on desktop and phone viewports, under the production headers and with the weather API mocked; includes an accessibility audit |
| `npm run check:reference` | Compare time zones against the live API; uses about 230 calls of the free quota                                                                                               |
| `npm run data`            | Rebuild `public/data`, `public/textures`, `src/data` and the icons; downloads NASA imagery, Natural Earth lakes, GeoNames cities and the star catalog                         |

Run `npx playwright install chromium firefox webkit` once before `npm run e2e`. To test one browser, add `-- --project=desktop` (or `mobile`, `firefox`, `webkit`, `iphone`).

## How it fits together

- `src/globe`: the Three.js scene, loaded separately so the time and weather appear first.
  - `shaders/planet.ts` ray traces the planet, its cloud layer and its atmosphere in one pass on a single shell: day and night imagery, sun glint on water, single scattering in the air, cloud shadows, city light under cloud and lightning. The surfaces are found analytically per pixel, so the limb stays smooth at any zoom.
  - `clouds.ts` draws the clouds into a cube map: fractal noise drifting on the prevailing winds, shaped by a weather field of current conditions (`src/weather/field.ts`). Only faces in view are redrawn, one at a time while cloud drifts.
  - `precipitation.ts` draws rain, snow, hail and fog as screen particles, each shown only where the cloud map says something falls below it.
  - `stars.ts` places the bright star catalog by sidereal time, and `sunGlare.ts` draws the sun when it shows past the limb.
  - `scene.ts` runs the frame loop. Every frame is drawn while the globe moves; otherwise cloud drift is drawn at 30 fps, falling rain at full rate, and after a minute without input, or with the window in the background, 10 fps and 20 fps. With reduced motion requested, nothing animates and frames are drawn only on change. Resolution drops when frames are slow and recovers when they're quick again (`pacing.ts`, `quality.ts`).
- `src/geo`: coordinates, sun position and sidereal time, time zones, and nearest-place names.
- `src/weather/provider.ts`: the only file that talks to the weather service. Once an hour, one batched request covers the city markers and about a hundred more points that fill the gaps over the oceans (`skyPoints.ts`); the batch counts as one call per place, about 200 an hour while the page is visible.
- `src/controller.ts`: connects the globe, data loading, and the store. `src/ui` is the React interface; `icons.ts` holds the weather icon shapes, drawn as images for the many markers and inline, animated, by `WeatherIcon.tsx` in the panel.

Add `?detail=low` or `?detail=high` to the URL to choose the detail level. Low uses 2K imagery, coarser clouds and fewer particles; it is chosen automatically on low-end touch devices and small GPUs. Without a GPU, as in a virtual machine, the globe also draws at half resolution unless `?detail=high` is given.

Texture files depend on nothing but the source imagery; rerun `npm run data` only to change them. The textures are cached by the service worker once seen, and only the current month's are ever downloaded.

## Deploying

`npm run build` writes a static site to `dist/`, which any static host can serve. Pushes to `main` deploy through Vercel's GitHub integration. `vercel.json` sets the security headers, including a Content-Security-Policy that only allows connections to this origin and Open-Meteo. On other hosts, copy those headers into the host's config. A new weather or search provider must also be added to `connect-src`.

## Licensing

[GPL-3.0](LICENSE).

The free Open-Meteo API is for non-commercial use only. Adding ads or subscriptions requires a paid plan. The app must keep showing its data credits:

- Weather: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- Place names: [GeoNames](https://www.geonames.org/) (CC BY 4.0)
- Land and lake shapes: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Earth imagery: NASA [Blue Marble Next Generation](https://science.nasa.gov/earth/earth-observatory/collections/blue-marble) and Black Marble 2016 city lights (public domain)
- Stars: the Yale Bright Star Catalogue, 5th revised edition (Hoffleit & Warren), via NASA HEASARC
