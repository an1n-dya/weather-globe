/**
 * Deterministic indexed icosphere, shared by the build-time land mask script
 * and the runtime mesh. Face order must match between the two: the land mask
 * stores one bit per face in exactly this order.
 */
export interface Icosphere {
  /** xyz triples on the unit sphere. */
  vertices: Float32Array;
  /** Vertex index triples, counter-clockwise when seen from outside. */
  faces: Uint32Array;
}

/** Full-detail globe: 20 * 64^2 = 81,920 faces, edges of roughly 120 km. */
export const FREQUENCY_HIGH = 64;
/** Weak devices: 20 * 40^2 = 32,000 faces. */
export const FREQUENCY_LOW = 40;

const PHI = (1 + Math.sqrt(5)) / 2;

const BASE_VERTICES: ReadonlyArray<readonly [number, number, number]> = [
  [-1, PHI, 0],
  [1, PHI, 0],
  [-1, -PHI, 0],
  [1, -PHI, 0],
  [0, -1, PHI],
  [0, 1, PHI],
  [0, -1, -PHI],
  [0, 1, -PHI],
  [PHI, 0, -1],
  [PHI, 0, 1],
  [-PHI, 0, -1],
  [-PHI, 0, 1],
];

const BASE_FACES: ReadonlyArray<readonly [number, number, number]> = [
  [0, 11, 5],
  [0, 5, 1],
  [0, 1, 7],
  [0, 7, 10],
  [0, 10, 11],
  [1, 5, 9],
  [5, 11, 4],
  [11, 10, 2],
  [10, 7, 6],
  [7, 1, 8],
  [3, 9, 4],
  [3, 4, 2],
  [3, 2, 6],
  [3, 6, 8],
  [3, 8, 9],
  [4, 9, 5],
  [2, 4, 11],
  [6, 2, 10],
  [8, 6, 7],
  [9, 8, 1],
];

export function faceCount(frequency: number): number {
  return 20 * frequency * frequency;
}

export function buildIcosphere(frequency: number): Icosphere {
  const positions: number[] = [];
  const lookup = new Map<string, number>();
  const faces = new Uint32Array(faceCount(frequency) * 3);
  let faceCursor = 0;

  const vertexAt = (x: number, y: number, z: number): number => {
    const length = Math.hypot(x, y, z);
    const nx = x / length;
    const ny = y / length;
    const nz = z / length;
    // Rounding merges the points two base faces compute along a shared edge.
    const key = `${Math.round(nx * 1e6)},${Math.round(ny * 1e6)},${Math.round(nz * 1e6)}`;
    const existing = lookup.get(key);
    if (existing !== undefined) return existing;
    const index = positions.length / 3;
    positions.push(nx, ny, nz);
    lookup.set(key, index);
    return index;
  };

  for (const [ia, ib, ic] of BASE_FACES) {
    const a = BASE_VERTICES[ia]!;
    const b = BASE_VERTICES[ib]!;
    const c = BASE_VERTICES[ic]!;

    // rows[i][j] is the point i steps from a toward b and j steps toward c.
    const rows: number[][] = [];
    for (let i = 0; i <= frequency; i++) {
      const row: number[] = [];
      for (let j = 0; j <= frequency - i; j++) {
        const k = frequency - i - j;
        row.push(
          vertexAt(
            a[0] * k + b[0] * i + c[0] * j,
            a[1] * k + b[1] * i + c[1] * j,
            a[2] * k + b[2] * i + c[2] * j,
          ),
        );
      }
      rows.push(row);
    }

    for (let i = 0; i < frequency; i++) {
      for (let j = 0; j < frequency - i; j++) {
        const row = rows[i]!;
        const next = rows[i + 1]!;
        faces[faceCursor++] = row[j]!;
        faces[faceCursor++] = next[j]!;
        faces[faceCursor++] = row[j + 1]!;
        if (j < frequency - i - 1) {
          faces[faceCursor++] = next[j]!;
          faces[faceCursor++] = next[j + 1]!;
          faces[faceCursor++] = row[j + 1]!;
        }
      }
    }
  }

  return { vertices: new Float32Array(positions), faces };
}
