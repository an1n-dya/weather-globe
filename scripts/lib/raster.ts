/**
 * Fills spherical polygons onto an equirectangular grid. d3-geo's projection
 * cuts shapes at the antimeridian and handles the poles; the planar rings it
 * draws are then filled with an even-odd scanline at each row's center.
 */
import { type GeoPermissibleObjects, geoArea, geoEquirectangular, geoPath } from "d3-geo";
import type { Feature, Geometry, MultiPolygon, Polygon } from "geojson";

/**
 * d3 decides which side of a ring is inside from its winding. A ring wound the
 * other way would cover the rest of the planet instead, so anything larger
 * than a hemisphere is turned around. Nothing used here is that large.
 */
export function rewind<G extends Geometry, P>(feature: Feature<G, P>): Feature<G, P> {
  const fix = (polygon: Polygon["coordinates"]) =>
    geoArea({ type: "Polygon", coordinates: polygon }) > 2 * Math.PI
      ? polygon.map((ring) => [...ring].reverse())
      : polygon;
  const geometry = feature.geometry;
  if (geometry?.type === "Polygon") {
    return { ...feature, geometry: { ...geometry, coordinates: fix(geometry.coordinates) } };
  }
  if (geometry?.type === "MultiPolygon") {
    const coordinates = (geometry as MultiPolygon).coordinates.map(fix);
    return { ...feature, geometry: { ...geometry, coordinates } as G };
  }
  return feature;
}

/** Calls `onSpan` for each run of filled cells, inclusive of both ends. */
export function rasterize(
  object: GeoPermissibleObjects,
  width: number,
  height: number,
  onSpan: (row: number, from: number, to: number) => void,
): void {
  const projection = geoEquirectangular()
    .scale(width / (2 * Math.PI))
    .translate([width / 2, height / 2])
    .precision(0.1);

  const crossings = new Map<number, number[]>();
  let start: [number, number] | null = null;
  let previous: [number, number] | null = null;

  const addEdge = (a: [number, number], b: [number, number]) => {
    const [x0, y0] = a;
    const [x1, y1] = b;
    if (y0 === y1) return;
    const top = Math.min(y0, y1);
    const bottom = Math.max(y0, y1);
    const firstRow = Math.max(0, Math.ceil(top - 0.5));
    const lastRow = Math.min(height - 1, Math.ceil(bottom - 0.5) - 1);
    for (let row = firstRow; row <= lastRow; row++) {
      const y = row + 0.5;
      let list = crossings.get(row);
      if (!list) {
        list = [];
        crossings.set(row, list);
      }
      list.push(x0 + ((y - y0) / (y1 - y0)) * (x1 - x0));
    }
  };

  const context = {
    beginPath() {},
    moveTo(x: number, y: number) {
      start = [x, y];
      previous = start;
    },
    lineTo(x: number, y: number) {
      const point: [number, number] = [x, y];
      if (previous) addEdge(previous, point);
      previous = point;
    },
    closePath() {
      if (previous && start) addEdge(previous, start);
      previous = start;
    },
    arc() {},
  };
  geoPath(projection, context as unknown as CanvasRenderingContext2D)(object);

  for (const [row, xs] of crossings) {
    xs.sort((a, b) => a - b);
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const from = Math.max(0, Math.ceil(xs[i]! - 0.5));
      const to = Math.min(width - 1, Math.ceil(xs[i + 1]! - 0.5) - 1);
      if (to >= from) onSpan(row, from, to);
    }
  }
}

/** One byte per cell, 1 where any of the shapes is. */
export function rasterizeMask(
  objects: ReadonlyArray<GeoPermissibleObjects>,
  width: number,
  height: number,
): Uint8Array {
  const mask = new Uint8Array(width * height);
  for (const object of objects) {
    rasterize(object, width, height, (row, from, to) => {
      mask.fill(1, row * width + from, row * width + to + 1);
    });
  }
  return mask;
}

/** The cell of an equirectangular grid that holds a point. */
export function cellIndex(width: number, height: number, lat: number, lon: number): number {
  const x = Math.min(width - 1, Math.max(0, Math.floor(((lon + 180) / 360) * width)));
  const y = Math.min(height - 1, Math.max(0, Math.floor(((90 - lat) / 180) * height)));
  return y * width + x;
}

/**
 * Gives every empty cell the value of the nearest filled one, wrapping east to
 * west. A breadth-first flood, so "nearest" is in grid steps, which is enough
 * to fill the gaps between neighboring shapes.
 */
export function fillFromNearest(grid: Uint16Array, width: number, height: number): void {
  let frontier: number[] = [];
  for (let i = 0; i < grid.length; i++) if (grid[i] !== 0) frontier.push(i);
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const i of frontier) {
      const x = i % width;
      const y = (i - x) / width;
      const neighbors = [
        y * width + ((x + 1) % width),
        y * width + ((x - 1 + width) % width),
        y > 0 ? i - width : -1,
        y < height - 1 ? i + width : -1,
      ];
      for (const n of neighbors) {
        if (n >= 0 && grid[n] === 0) {
          grid[n] = grid[i]!;
          next.push(n);
        }
      }
    }
    frontier = next;
  }
}
