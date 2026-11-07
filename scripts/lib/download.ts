import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const cacheDir = join(root, "node_modules", ".cache", "weather-globe");

/** Natural Earth vectors (public domain), pinned to a release. */
export const naturalEarth = (name: string) =>
  `https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/${name}.geojson`;

/**
 * Downloads a file once and keeps it in node_modules/.cache, so rebuilding the
 * data doesn't fetch it again. Downloads are only ever parsed as data.
 */
export async function cachedDownload(url: string, name: string): Promise<Buffer> {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, name);
  if (!existsSync(file)) {
    console.log(`downloading ${url}`);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
    writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  }
  return readFileSync(file);
}

export async function cachedJson<T>(url: string, name: string): Promise<T> {
  return JSON.parse((await cachedDownload(url, name)).toString("utf8")) as T;
}
