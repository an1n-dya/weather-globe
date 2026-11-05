import { latLonToVec3 } from "../geo/coords";

const LATTICE_SIZE = 160;
const CLEARANCE_KM = 1000;
const EARTH_RADIUS_KM = 6371;
const GOLDEN_ANGLE_DEG = 180 * (3 - Math.sqrt(5));

export interface LatLon {
  lat: number;
  lon: number;
}

const round = (value: number) => Math.round(value * 100) / 100;

/**
 * Extra weather samples for the cloud layer where the city markers leave gaps,
 * mostly over the oceans: the points of an even spiral lattice that are far
 * from every city. About a hundred, so with the cities one hourly request
 * covers the whole globe. Deterministic, so saved rows stay aligned with it.
 */
export function skyPoints(cities: ReadonlyArray<LatLon>): LatLon[] {
  const minDot = Math.cos(CLEARANCE_KM / EARTH_RADIUS_KM);
  const cityVectors = cities.map((city) => latLonToVec3(city.lat, city.lon));
  const points: LatLon[] = [];
  for (let i = 0; i < LATTICE_SIZE; i++) {
    const lat = (Math.asin(1 - (2 * (i + 0.5)) / LATTICE_SIZE) * 180) / Math.PI;
    const lon = ((((i * GOLDEN_ANGLE_DEG) % 360) + 540) % 360) - 180;
    const [x, y, z] = latLonToVec3(lat, lon);
    const clear = cityVectors.every(([cx, cy, cz]) => cx * x + cy * y + cz * z < minDot);
    if (clear) points.push({ lat: round(lat), lon: round(lon) });
  }
  return points;
}
