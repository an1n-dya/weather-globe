/**
 * Downloads NASA imagery (public domain) and writes the globe's textures:
 *   public/textures/day-<MM>-<size>.webp  Blue Marble Next Generation with topography,
 *                                         one per month, so the globe shows this
 *                                         month's snow and vegetation
 *   public/textures/lights-<size>.webp    Black Marble 2016 city lights, with the
 *                                         moonlit ground taken out
 * Sizes are 4096x2048 ("4k") for capable devices and 2048x1024 ("2k") for the rest.
 * Downloads are kept in node_modules/.cache, so a rebuild doesn't fetch them again.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const NASA = "https://assets.science.nasa.gov/content/dam/science/esd/eo/images";
const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const SIZES = [
  ["4k", 4096],
  ["2k", 2048],
] as const;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, "node_modules", ".cache", "weather-globe");
const outDir = join(root, "public", "textures");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

async function cached(url: string, name: string): Promise<string> {
  const file = join(cacheDir, name);
  if (existsSync(file)) return file;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status} for ${url}`);
  writeFileSync(file, new Uint8Array(await response.arrayBuffer()));
  return file;
}

async function write(image: sharp.Sharp, name: string): Promise<void> {
  const info = await image.toFile(join(outDir, name));
  console.log(`${name}: ${(info.size / 1024).toFixed(0)} KB`);
}

for (const [index, month] of MONTHS.entries()) {
  const mm = String(index + 1).padStart(2, "0");
  const source = await cached(
    `${NASA}/bmng/bmng-topography/${month}/world.topo.2004${mm}.3x5400x2700.jpg`,
    `bmng-topo-${mm}.jpg`,
  );
  for (const [size, width] of SIZES) {
    await write(
      sharp(source)
        .resize(width, width / 2, { kernel: "lanczos3" })
        .webp({ quality: size === "4k" ? 78 : 80, effort: 6 }),
      `day-${mm}-${size}.webp`,
    );
  }
}

/**
 * The lights are warm and the moonlit ground behind them is blue, so the warm
 * excess over blue keeps the lights, even bright white city cores, and drops
 * the ground, even the bright ice of Antarctica and Greenland.
 */
const blackMarble = await cached(
  `${NASA}/imagerecords/144000/144898/BlackMarble_2016_3km.jpg`,
  "black-marble-2016-3km.jpg",
);
for (const [size, width] of SIZES) {
  const { data, info } = await sharp(blackMarble, { limitInputPixels: false })
    .resize(width, width / 2, { kernel: "lanczos3" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const lights = new Uint8Array(info.width * info.height);
  for (let i = 0, j = 0; j < lights.length; i += info.channels, j++) {
    const warm = Math.min(data[i]!, data[i + 1]!);
    lights[j] = Math.min(255, Math.max(0, Math.round((warm - 0.62 * data[i + 2]!) / 0.38)));
  }
  await write(
    sharp(lights, { raw: { width: info.width, height: info.height, channels: 1 } }).webp({
      quality: 80,
      effort: 6,
    }),
    `lights-${size}.webp`,
  );
}
console.log("textures written to public/textures");
