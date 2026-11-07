# Weather Globe

Spin a low-poly globe to see the local time and weather anywhere on Earth. The reticle marks the selected place: time updates as you drag, and weather loads when you stop.

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
| `npm run check:reference` | Compare time zones against the live API; uses about 110 calls of the free quota                                                                                               |
| `npm run data`            | Rebuild `public/data`, `src/data` and the icons; downloads GeoNames cities and Natural Earth seas, lakes and regions                                                         |

Run `npx playwright install chromium firefox webkit` once before `npm run e2e`. To test one browser, add `-- --project=desktop` (or `mobile`, `firefox`, `webkit`, `iphone`). On a Linux machine without a GPU, headless Firefox has no WebGL; run that project headed under a virtual display instead: `xvfb-run -a npx playwright test --project=firefox --headed`.

## How it fits together

- `src/globe`: the Three.js scene, loaded separately so the time and weather appear first. The mesh is built in a worker (`earthWorker.ts`). The Earth is an icosphere whose faces are marked land or water by a 1-bit mask built ahead of time (`scripts/build-land-mask.ts`). The mask depends on face order, so rebuild it if `icosphere.ts` changes.
- `src/geo`: coordinates, sun position, time zones, and place names. Names come from the nearest GeoNames town, or, away from towns, from `public/data/regions.bin` (`scripts/build-regions.ts`): the sea or lake, the country, and named regions such as deserts and mountain ranges.
- `src/weather/provider.ts`: the only file that talks to the weather service.
- `src/controller.ts`: connects the globe, data loading, and the store. `src/ui` is the React interface.

Add `?detail=low` to the URL to force the lighter 32,000-face globe. It is chosen automatically on low-end touch devices.

## Deploying

`npm run build` writes a static site to `dist/`, which any static host can serve. Pushes to `main` deploy through Vercel's GitHub integration. `vercel.json` sets the security headers, including a Content-Security-Policy that only allows connections to this origin and Open-Meteo. On other hosts, copy those headers into the host's config. A new weather or search provider must also be added to `connect-src`.

## Licensing

[GPL-3.0](LICENSE).

The free Open-Meteo API is for non-commercial use only. Adding ads or subscriptions requires a paid plan. The app must keep showing its data credits:

- Weather: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- Place names: [GeoNames](https://www.geonames.org/) (CC BY 4.0)
- Land shapes: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
