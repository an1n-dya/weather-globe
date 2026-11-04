/**
 * Writes public/data/stars.bin from the Yale Bright Star Catalogue, 5th revised
 * edition (Hoffleit & Warren), via NASA HEASARC: about 9,100 stars, everything
 * an eye can see on a dark night.
 *
 * Stars are sorted brightest first, so a reader can take only the brightest.
 * Each is 8 bytes, little-endian: right ascension (uint16, a fraction of 360°),
 * declination (int16, a fraction of 90°), then V magnitude and B-V color
 * (int16 each, in hundredths).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const SOURCE = "https://heasarc.gsfc.nasa.gov/FTP/heasarc/dbase/tdat_files/heasarc_bsc5p.tdat.gz";
/** B-V of a Sun-like star, for the few entries without a color. */
const DEFAULT_BV = 0.65;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const response = await fetch(SOURCE);
if (!response.ok) throw new Error(`Star catalog download failed: HTTP ${response.status}`);
const text = new TextDecoder().decode(gunzipSync(new Uint8Array(await response.arrayBuffer())));

// The header names the pipe-separated fields of each row.
const fields = /^line\[1\] = (.+)$/m.exec(text)?.[1]?.trim().split(/\s+/) ?? [];
const column = (name: string) => {
  const index = fields.indexOf(name);
  if (index < 0) throw new Error(`Star catalog has no ${name} field`);
  return index;
};
const RA = column("ra");
const DEC = column("dec");
const VMAG = column("vmag");
const BV = column("bv_color");

const body = text.slice(text.indexOf("<DATA>") + 6, text.indexOf("<END>"));
const stars: Array<{ ra: number; dec: number; vmag: number; bv: number }> = [];
for (const line of body.split("\n")) {
  const cols = line.split("|");
  if (cols.length < fields.length) continue;
  const ra = Number.parseFloat(cols[RA]!);
  const dec = Number.parseFloat(cols[DEC]!);
  const vmag = Number.parseFloat(cols[VMAG]!);
  const bv = Number.parseFloat(cols[BV]!);
  // A few entries are novae or clusters with no usable position or brightness.
  if (![ra, dec, vmag].every(Number.isFinite)) continue;
  stars.push({ ra, dec, vmag, bv: Number.isFinite(bv) ? bv : DEFAULT_BV });
}
stars.sort((a, b) => a.vmag - b.vmag);

const view = new DataView(new ArrayBuffer(stars.length * 8));
stars.forEach((star, i) => {
  view.setUint16(i * 8, Math.round((star.ra / 360) * 65536) % 65536, true);
  view.setInt16(i * 8 + 2, Math.round((star.dec / 90) * 32767), true);
  view.setInt16(i * 8 + 4, Math.round(star.vmag * 100), true);
  view.setInt16(i * 8 + 6, Math.round(Math.max(-0.5, Math.min(2.5, star.bv)) * 100), true);
});

mkdirSync(join(root, "public/data"), { recursive: true });
writeFileSync(join(root, "public/data/stars.bin"), new Uint8Array(view.buffer));
console.log(`${stars.length} stars, brightest ${stars[0]?.vmag}, faintest ${stars.at(-1)?.vmag}`);
