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
  build: { chunkSizeWarningLimit: 800 },
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
        // The app shell and map data work offline. Weather always goes to the network.
        globPatterns: ["**/*.{js,css,html,svg,png,bin,json}"],
        // The share card is only for link previews.
        globIgnores: ["og.jpg"],
        maximumFileSizeToCacheInBytes: 3 * 1024 * 1024,
      },
    }),
  ],
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
