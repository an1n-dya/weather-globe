# Weather Globe

Spin a low-poly globe to see the local time and weather anywhere on Earth. The reticle marks the selected place: time updates as you drag, and weather loads when you stop.

## Features

- **A detailed low-poly Earth.** Faceted triangles of varied size: fine along coastlines, so Italy, Japan, the Caribbean or the Great Lakes are recognizable, and large over open ocean and deep interiors. Mountains and plateaus rise in relief with snow on the peaks, the sea shades from turquoise shelves to deep trenches, and the land is colored by biome. It follows the seasons: snow spreads across the northern continents in winter and melts back in spring, lakes freeze, and sea ice grows and shrinks around both poles, month by month from real observations. The sun lights it from its real position, with a soft terminator, a glint on the water, a moonlit night side and city lights.
- **Local time.** A large clock in the place's own time zone, its UTC offset (including half and three-quarter hours), how far ahead or behind you it is, whether it's already tomorrow there, a bar showing how far through its day it is, and a sun arc with sunrise, sunset and day length (or midnight sun and polar night).
- **Weather.** Current conditions, the next 24 hours with the chance of rain, the week ahead on one temperature scale, and wind (with direction and gusts), humidity and dew point, UV index, pressure, visibility and cloud cover. Errors say why (offline, busy, timed out) and when the next try is.
- **Places.** Names come from the nearest town, or the sea, lake, desert or mountain range and country when there's no town nearby. Search shows flags and the local time of each result. Save places, revisit recent ones, compare two places' clocks, and share a link to the current view.
- **Getting around.** Drag with inertia, pinch or scroll to zoom, double-click or double-tap to zoom in somewhere, use the arrow keys and `+`/`-`, press `/` to search, find your location, or go back to the whole globe.
- **Fits the screen.** A side panel on wide screens; on upright phones and tablets, a bottom sheet you can drag between collapsed, half and full height, with the globe kept in view above it.
- **Units.** °C or °F, 12- or 24-hour clock, and km/h, mph or m/s, with defaults from your locale and remembered on this device.
- **Light and private.** No accounts, tracking or cookies; saved places stay in your browser. The app shell and map data work offline. Without WebGL, search and the panel still work.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Commands

| Command                   | What it does                                                                                                                                                                                           |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm run dev`             | Dev server                                                                                                                                                                                             |
| `npm run build`           | Type-check and build to `dist/` for any static host                                                                                                                                                    |
| `npm run preview`         | Serve the production build, with the production security headers                                                                                                                                       |
| `npm run lint`            | Check formatting and lint rules with Biome                                                                                                                                                             |
| `npm run format`          | Fix formatting and safe lint issues                                                                                                                                                                    |
| `npm run typecheck`       | Type-check without building                                                                                                                                                                            |
| `npm test`                | Unit tests                                                                                                                                                                                             |
| `npm run e2e`             | Browser tests in Chromium, Firefox, and WebKit, on desktop and phone viewports, under the production headers and with the weather API mocked; includes an accessibility audit                          |
| `npm run check:reference` | Compare time zones against the live API; uses about 110 calls of the free quota                                                                                                                        |
| `npm run data`            | Rebuild `public/data`, `src/data` and the icons; downloads GeoNames cities, Natural Earth shapes, ETOPO5, a year of Blue Marble and NSIDC sea ice grids (about 50 MB, cached in `node_modules/.cache`) |

Run `npx playwright install chromium firefox webkit` once before `npm run e2e`. To test one browser, add `-- --project=desktop` (or `mobile`, `firefox`, `webkit`, `iphone`). On a Linux machine without a GPU, headless Firefox has no WebGL; run that project headed under a virtual display instead: `xvfb-run -a npx playwright test --project=firefox --headed`.

## How it fits together

- `src/globe`: the Three.js scene, loaded separately so the time and weather appear first. The globe is built from `public/data/earth.bin`, a list of points written by `scripts/build-earth.ts`: dense along coastlines (about 19 km apart, with a land point and a water point either side of the line), sparse in open ocean and deep interiors, and denser in rough terrain. The file streams into a worker (`earthWorker.ts`, started by `earthLoader.ts` as the app boots, while three.js is still downloading), which triangulates the points on the sphere (Delaunay, via stereographic projection) and colors each face from its corners: biome from NASA Blue Marble vegetation, height and depth from NOAA ETOPO5, and the snow and ice of today's date. Each point carries one bit per month: snow on land where that month's Blue Marble is white, ice at sea where the NSIDC Sea Ice Index shows it in most of 2023 to 2025, and ice on lakes once the land around them has been under snow for a month. Between the middles of two months the globe blends them, so the snow line moves a few facets at a time. Land is raised in proportion to its height, about 12 times true scale; the sea keeps its depth as color only. The scene starts once the first paint is on screen, compiles its shaders before drawing, draws only when something changes, and stops its animation loop when idle.
- `src/geo`: coordinates, sun position, time zones, and place names. Names come from the nearest GeoNames town, or, away from towns, from the sea or lake, the country, and named regions such as deserts and mountain ranges.
- `src/weather/provider.ts`: the only file that talks to the weather service.
- `src/controller.ts`: connects the globe, data loading, and the store. `src/ui` is the React interface.

### Data files

| File                        | Built by                   | Holds                                                                                                                                     |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `public/data/earth.bin`     | `scripts/build-earth.ts`   | The globe's points: position, land or water, height or depth, biome, and the months with snow or ice (format in `src/globe/earthData.ts`) |
| `public/data/regions.bin`   | `scripts/build-regions.ts` | Land, water and lakes at 0.1°, and names of seas, lakes, countries and regions                                                            |
| `public/data/cities.bin`    | `scripts/build-cities.ts`  | Every town over 15,000 people, for names and night lights (format in `src/geo/citiesData.ts`)                                             |
| `src/data/majorCities.json` | `scripts/build-cities.ts`  | About 100 well-spread cities for the weather badges                                                                                       |

All three `.bin` files are DEFLATE-compressed and inflated in the browser with `DecompressionStream`, or `fflate` where that isn't available.

Because the globe's faces are built from points and nothing is stored per face, there is no face order to keep in step with any mask. Change `scripts/build-earth.ts` (spacing, levels, biome rules) and run `npx tsx scripts/build-earth.ts` to rebuild `earth.bin`; the app follows. The unit tests check that every tier triangulates into a closed surface with every face outward, and that land, sea and lakes fall where they should.

### Detail tiers

The points come coarse to fine, so a prefix of the file is itself a complete, coarser globe. Three detail tiers use that:

| Tier     | Faces    | Used for                                                            |
| -------- | -------- | ------------------------------------------------------------------- |
| `low`    | ~32,600  | low-end touch devices, software rendering, and the first quick draw |
| `medium` | ~90,500  | other phones and tablets                                            |
| `high`   | ~177,400 | everything else                                                     |

The file is stored level by level, so the light globe can be built once the first fifth of it has arrived; the chosen tier fades in over it when the rest is in. Software rendering (SwiftShader, llvmpipe), where the CPU draws every triangle, gets the light globe at a pixel ratio of 1. Add `?detail=low`, `?detail=medium` or `?detail=high` to the URL to force a tier.

## Deploying

`npm run build` writes a static site to `dist/`, which any static host can serve. Pushes to `main` deploy through Vercel's GitHub integration. `vercel.json` sets the security headers, including a Content-Security-Policy that only allows connections to this origin and Open-Meteo, and cache lifetimes: a year for hashed assets, a day (then served stale while it refreshes) for `public/data`. On other hosts, copy those headers into the host's config. The service worker stores the app shell as it installs, and three.js and `public/data` as the page first uses them (`src/offline.ts`), so a first visit downloads each file once and later visits open offline. A new weather or search provider must also be added to `connect-src`. The link preview image (`public/og.jpg`) is referenced by its absolute production URL in `index.html`.

## Licensing

[GPL-3.0](LICENSE).

The free Open-Meteo API is for non-commercial use only. Adding ads or subscriptions requires a paid plan. The app must keep showing its data credits:

- Weather: [Open-Meteo](https://open-meteo.com/) (CC BY 4.0)
- Place names: [GeoNames](https://www.geonames.org/) (CC BY 4.0)
- Land shapes, lakes, seas and regions: [Natural Earth](https://www.naturalearthdata.com/) (public domain)
- Elevation and sea depth: [NOAA NCEI ETOPO5](https://www.ncei.noaa.gov/products/etopo-global-relief-model) (public domain)
- Vegetation and the snow of each month: [NASA Blue Marble Next Generation](https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/) (public domain)
- Sea ice: [NSIDC Sea Ice Index, version 4](https://nsidc.org/data/g02135/versions/4) (Fetterer, F., K. Knowles, W. N. Meier, M. Savoie and A. K. Windnagel; NOAA@NSIDC)
