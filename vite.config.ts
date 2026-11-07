import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import { defineConfig } from "vitest/config";
import vercel from "./vercel.json" with { type: "json" };

// The preview server sends the production headers, so the browser tests run
// under the same Content-Security-Policy as the live site.
const productionHeaders = Object.fromEntries(
  (vercel.headers[0]?.headers ?? []).map(({ key, value }) => [
    key,
    // This directive upgrades requests to https, which a local http server can't serve.
    value.replace("; upgrade-insecure-requests", ""),
  ]),
);

export default defineConfig({
  // Relative paths, so the build works on any host or subfolder.
  base: "./",
  preview: { headers: productionHeaders },
  // three.js is one large module that can't be split further, and it loads lazily.
  // Source maps are published too: the code is GPL, and they make reports from the field readable.
  build: { chunkSizeWarningLimit: 800, sourcemap: true },
  // Module workers can split code, so the globe worker doesn't carry the
  // inflater that only browsers without DecompressionStream need.
  worker: { format: "es" },
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        id: "./",
        name: "Weather Globe",
        short_name: "Globe",
        description: "Spin a low-poly globe to see the local time and weather anywhere on Earth.",
        start_url: "./",
        scope: "./",
        categories: ["weather", "travel", "utilities"],
        theme_color: "#070d1f",
        background_color: "#070d1f",
        display: "standalone",
        orientation: "any",
        icons: [
          { src: "icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "icon-512.png", sizes: "512x512", type: "image/png" },
          {
            src: "icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      },
      workbox: {
        // The app shell is stored as the service worker installs, so it opens offline.
        // Weather always goes to the network.
        globPatterns: ["**/*.{js,css,html,svg,png,json}"],
        // three.js and the map data are kept as the page first uses them instead: stored
        // at install, they were downloaded twice on a first visit, once by the page and
        // once by the service worker. The share card is only for link previews.
        globIgnores: ["og.jpg", "**/scene-*.js"],
        runtimeCaching: [
          {
            urlPattern: /\/data\/[\w-]+\.bin$/,
            // Served at once, and refreshed in the background for next time.
            handler: "StaleWhileRevalidate",
            // A copy stored by a plain fetch must also answer the app's own request.
            options: {
              cacheName: "map-data",
              expiration: { maxEntries: 8 },
              matchOptions: { ignoreVary: true },
            },
          },
          {
            urlPattern: /\/assets\/scene-[\w-]+\.js$/,
            // Hashed, so a stored copy never goes stale; old versions are dropped.
            handler: "CacheFirst",
            options: {
              cacheName: "globe-code",
              expiration: { maxEntries: 2 },
              matchOptions: { ignoreVary: true },
            },
          },
        ],
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
