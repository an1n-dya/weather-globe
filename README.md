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
| `npm run data`            | Rebuild `public/data`, `src/data` and the icons; downloads GeoNames cities, Natural Earth shapes, ETOPO5 and Blue Marble (about 25 MB, cached in `node_modules/.cache`)       |

Run `npx playwright install chromium firefox webkit` once before `npm run e2e`. To test one browser, add `-- --project=desktop` (or `mobile`, `firefox`, `webkit`, `iphone`). On a Linux machine without a GPU, headless Firefox has no WebGL; run that project headed under a virtual display instead: `xvfb-run -a npx playwright test --project=firefox --headed`.

## How it fits together

- `src/globe`: the Three.js scene, loaded separately so the time and weather appear first. The globe is built from `public/data/earth.bin`, a list of points written by `scripts/build-earth.ts`: dense along coastlines (about 19 km apart, with a land point and a water point either side of the line), sparse in open ocean and deep interiors, and denser in rough terrain. A worker (`earthWorker.ts`) triangulates them on the sphere (Delaunay, via stereographic projection) and colors each face from its corners: biome from NASA Blue Marble vegetation, height and depth from NOAA ETOPO5. Land is raised in proportion to its height, about 12 times true scale; the sea keeps its depth as color only.
- Because faces are built from points and nothing is stored per face, there is no face order to keep in step with any mask. Change `scripts/build-earth.ts` (spacing, levels, biome rules) and run `npx tsx scripts/build-earth.ts` to rebuild `public/data/earth.bin`; the app follows.
- `src/geo`: coordinates, sun position, time zones, and place names. Names come from the nearest GeoNames town, or, away from towns, from `public/data/regions.bin` (`scripts/build-regions.ts`): the sea or lake, the country, and named regions such as deserts and mountain ranges.
- `src/weather/provider.ts`: the only file that talks to the weather service.
- `src/controller.ts`: connects the globe, data loading, and the store. `src/ui` is the React interface.

The points come coarse to fine, so a prefix of the file is itself a complete, coarser globe. Three detail tiers use that:

| Tier     | Faces    | Used for                                        |
| -------- | -------- | ----------------------------------------------- |
| `low`    | ~32,600  | low-end touch devices, and the first quick draw |
| `medium` | ~90,500  | other phones and tablets                        |
| `high`   | ~177,400 | everything else                                 |

The light globe appears first and the chosen tier fades in over it. Add `?detail=low`, `?detail=medium` or `?detail=high` to the URL to force a tier.

## Deploying

`npm run build` writes a static site to `dist/`, which any static host can serve. Pushes to `main` deploy through Vercel's GitHub integration. `vercel.json` sets the security headers, including a Content-Security-Policy that only allows connections to this origin and Open-Meteo. On other hosts, copy those headers into the host's config. A new weather or search provider must also be added to `connect-src`.

## Licensing

[GPL-3.0](LICENSE).

The free Open-Meteo API is for non-commercial use only. Adding ads or subscriptions requires a paid plan. The app must keep showing its data credits:

- Weather: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- Place names: [GeoNames](https://www.geonames.org/) (CC BY 4.0)
- Land shapes, lakes, seas and regions: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Elevation and sea depth: [NOAA NCEI ETOPO5](https://www.ncei.noaa.gov/products/etopo-global-relief-model) (public domain)
- Vegetation, for the biome colors: [NASA Blue Marble Next Generation](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/) (public domain)
