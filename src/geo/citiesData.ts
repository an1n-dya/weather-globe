/**
 * The format of public/data/cities.bin, shared by scripts/build-cities.ts and
 * the app. Columns rather than JSON rows, so it inflates to a third less than
 * gzipped JSON and parses without building 32,000 small arrays from text.
 *
 *   "WGC1", header length (u32 LE), header JSON padded to 4 bytes, then
 *   lat        count x i16  hundredths of a degree
 *   lon        count x i16  hundredths of a degree
 *   country    count x u8   index into the header's country codes
 *   population count varints, each the zigzagged change from the previous one
 *   names      UTF-8, one per line
 *
 * Rows stay in the order given: largest population first.
 */

/** [name, country code, lat, lon, population] */
export type CityRow = [string, string, number, number, number];

const MAGIC = "WGC1";

interface Header {
  count: number;
  countries: string[];
}

const zigzag = (v: number) => (v >= 0 ? v * 2 : -v * 2 - 1);
const unzigzag = (v: number) => (v % 2 === 0 ? v / 2 : -(v + 1) / 2);

export function encodeCities(rows: ReadonlyArray<CityRow>): Uint8Array {
  const count = rows.length;
  const countries = [...new Set(rows.map((r) => r[1]))].sort();
  if (countries.length > 255) throw new Error("Too many countries for one byte");
  const header = new TextEncoder().encode(JSON.stringify({ count, countries } satisfies Header));
  const headerLength = Math.ceil(header.length / 4) * 4;

  const varints: number[] = [];
  let previous = 0;
  for (const row of rows) {
    // Arithmetic, not bit operations: populations can pass 2^31 when zigzagged.
    let v = zigzag(row[4] - previous);
    previous = row[4];
    while (v >= 0x80) {
      varints.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    varints.push(v);
  }
  const names = new TextEncoder().encode(rows.map((r) => r[0].replace(/\n/g, " ")).join("\n"));

  const body = 8 + headerLength;
  const file = new Uint8Array(body + count * 5 + varints.length + names.length);
  const view = new DataView(file.buffer);
  file.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint32(4, headerLength, true);
  file.set(header, 8);
  file.fill(0x20, 8 + header.length, body);
  const index = new Map(countries.map((code, i) => [code, i]));
  rows.forEach((row, i) => {
    view.setInt16(body + i * 2, Math.round(row[2] * 100), true);
    view.setInt16(body + count * 2 + i * 2, Math.round(row[3] * 100), true);
    file[body + count * 4 + i] = index.get(row[1]) ?? 0;
  });
  file.set(varints, body + count * 5);
  file.set(names, body + count * 5 + varints.length);
  return file;
}

/** Reads an inflated cities.bin. Throws if the file is not one. */
export function decodeCities(file: Uint8Array): CityRow[] {
  if (new TextDecoder().decode(file.subarray(0, 4)) !== MAGIC) throw new Error("Not a cities file");
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const headerLength = view.getUint32(4, true);
  const { count, countries } = JSON.parse(
    new TextDecoder().decode(file.subarray(8, 8 + headerLength)),
  ) as Header;
  const body = 8 + headerLength;
  if (!Number.isInteger(count) || count < 0 || body + count * 5 > file.length) {
    throw new Error("Cities file is truncated");
  }

  const populations = new Array<number>(count);
  let cursor = body + count * 5;
  let previous = 0;
  for (let i = 0; i < count; i++) {
    let value = 0;
    let scale = 1;
    let byte: number;
    do {
      byte = file[cursor++] ?? 0;
      value += (byte & 0x7f) * scale;
      scale *= 0x80;
    } while (byte & 0x80 && cursor < file.length);
    previous += unzigzag(value);
    populations[i] = previous;
  }
  const names = new TextDecoder().decode(file.subarray(cursor)).split("\n");
  if (names.length !== count) throw new Error("Cities file has the wrong number of names");

  const rows: CityRow[] = new Array(count);
  for (let i = 0; i < count; i++) {
    rows[i] = [
      names[i] ?? "",
      countries[file[body + count * 4 + i] ?? 0] ?? "",
      view.getInt16(body + i * 2, true) / 100,
      view.getInt16(body + count * 2 + i * 2, true) / 100,
      populations[i] ?? 0,
    ];
  }
  return rows;
}
