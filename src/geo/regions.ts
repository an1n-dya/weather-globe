import { normalizeLon } from "./coords";

/** What covers the ground at a point. Shared with scripts/build-regions.ts. */
export const SURFACE = { ocean: 0, land: 1, lake: 2, iceShelf: 3 } as const;
export type Surface = (typeof SURFACE)[keyof typeof SURFACE];

interface GridMeta {
  width: number;
  height: number;
  offset: number;
  length: number;
  names?: string[];
}

interface NameGrid {
  width: number;
  height: number;
  cells: Uint16Array;
  names: string[];
}

function cellOf(width: number, height: number, lat: number, lon: number): number {
  const x = Math.min(width - 1, Math.max(0, Math.floor(((normalizeLon(lon) + 180) / 360) * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)));
  return y * width + x;
}

/**
 * Offline lookups for "what is here": land or water, and the names of the sea,
 * lake, country and wider region. Built by scripts/build-regions.ts.
 */
export class Regions {
  private readonly surfaceWidth: number;
  private readonly surfaceHeight: number;
  private readonly surface: Uint8Array;
  private readonly marine: NameGrid;
  private readonly lakes: NameGrid;
  private readonly countries: NameGrid;
  private readonly regions: NameGrid;

  /** Takes the inflated file. Throws if it isn't one. */
  constructor(file: Uint8Array) {
    const magic = new TextDecoder().decode(file.subarray(0, 4));
    if (magic !== "WGR1") throw new Error("Not a regions file");
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const headerLength = view.getUint32(4, true);
    const layout = JSON.parse(
      new TextDecoder().decode(file.subarray(8, 8 + headerLength)),
    ) as Record<string, GridMeta>;
    const bodyStart = file.byteOffset + 8 + headerLength;

    const section = (key: string): GridMeta => {
      const meta = layout[key];
      if (!meta || bodyStart - file.byteOffset + meta.offset + meta.length > file.byteLength) {
        throw new Error(`Regions file is missing ${key}`);
      }
      return meta;
    };
    const named = (key: string): NameGrid => {
      const meta = section(key);
      return {
        width: meta.width,
        height: meta.height,
        // Sections start on 4-byte boundaries, so this reads in place without a copy.
        cells: new Uint16Array(file.buffer, bodyStart + meta.offset, meta.length / 2),
        names: meta.names ?? [""],
      };
    };

    const surface = section("surface");
    this.surfaceWidth = surface.width;
    this.surfaceHeight = surface.height;
    this.surface = new Uint8Array(file.buffer, bodyStart + surface.offset, surface.length);
    this.marine = named("marine");
    this.lakes = named("lakes");
    this.countries = named("countries");
    this.regions = named("regions");
  }

  surfaceAt(lat: number, lon: number): Surface {
    const i = cellOf(this.surfaceWidth, this.surfaceHeight, lat, lon);
    return (((this.surface[i >> 2] ?? 0) >> ((i & 3) * 2)) & 3) as Surface;
  }

  isLand(lat: number, lon: number): boolean {
    const surface = this.surfaceAt(lat, lon);
    return surface === SURFACE.land || surface === SURFACE.iceShelf;
  }

  /** The sea, gulf or ocean here or nearest to here. */
  seaAt(lat: number, lon: number): string {
    return this.nameAt(this.marine, lat, lon);
  }

  lakeAt(lat: number, lon: number): string {
    return this.nameAt(this.lakes, lat, lon);
  }

  /** The country here, or the nearest one for coastal water. */
  countryAt(lat: number, lon: number): string {
    return this.nameAt(this.countries, lat, lon);
  }

  /** A desert, mountain range, plateau, island group and so on, if any. */
  regionAt(lat: number, lon: number): string {
    return this.nameAt(this.regions, lat, lon);
  }

  private nameAt(grid: NameGrid, lat: number, lon: number): string {
    return grid.names[grid.cells[cellOf(grid.width, grid.height, lat, lon)] ?? 0] ?? "";
  }
}
