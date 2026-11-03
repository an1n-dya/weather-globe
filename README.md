# Weather Globe

Spin a low-poly globe to see the local time and weather anywhere on Earth. The reticle marks the selected place: time updates as you drag, and weather loads when you stop.

## Run it

```bash
npm install
npm run dev
```

Then open http://localhost:5173.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Dev server |
| `npm run build` | Type-check and build to `dist/` for any static host |
| `npm run preview` | Serve the production build |
| `npm test` | Unit tests |
| `npm run e2e` | Browser tests on desktop and phone viewports, with the weather API mocked |
| `npm run check:reference` | Compare time zones against the live API; uses about 110 calls of the free quota |
| `npm run data` | Rebuild `public/data`, `src/data` and the icons; downloads GeoNames cities |

Run `npx playwright install chromium` once before `npm run e2e`.

## How it fits together

- `src/globe`: the Three.js scene. The Earth is an icosphere whose faces are marked land or water by a 1-bit mask built ahead of time (`scripts/build-land-mask.ts`). The mask depends on face order, so rebuild it if `icosphere.ts` changes.
- `src/geo`: coordinates, sun position, time zones, and nearest-place names.
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
