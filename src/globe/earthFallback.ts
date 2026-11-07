import { inflate } from "../inflate";
import { type DetailTier, decodeEarth } from "./earthData";
import { buildEarthArrays, type EarthArrays } from "./earthMesh";

/** Builds the globe on the main thread, for when a worker can't start. */
export async function buildOnMainThread(file: ArrayBuffer, tier: DetailTier): Promise<EarthArrays> {
  const points = decodeEarth(await inflate(new Uint8Array(file)));
  return buildEarthArrays(points, points.header.tiers[tier]);
}
