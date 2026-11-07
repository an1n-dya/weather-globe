/// <reference lib="webworker" />
import { inflate } from "../inflate";
import { type DetailTier, decodeEarth } from "./earthData";
import { buildEarthArrays, type EarthArrays } from "./earthMesh";

export interface EarthRequest {
  /** The compressed earth.bin, as fetched. */
  file: ArrayBuffer;
  /** Coarse to fine; each is sent back as soon as it's built. */
  tiers: DetailTier[];
}

export type EarthReply =
  | { tier: DetailTier; arrays: EarthArrays; faces: number }
  | { error: string };

/** Builds the globe off the main thread: decoding and triangulating take a while on a phone. */
self.onmessage = async ({ data }: MessageEvent<EarthRequest>) => {
  try {
    const points = decodeEarth(await inflate(new Uint8Array(data.file)));
    for (const tier of data.tiers) {
      const arrays = buildEarthArrays(points, points.header.tiers[tier]);
      const reply: EarthReply = { tier, arrays, faces: arrays.positions.length / 9 };
      self.postMessage(reply, {
        transfer: [arrays.positions.buffer, arrays.colors.buffer],
      });
    }
  } catch (error) {
    self.postMessage({
      error: error instanceof Error ? error.message : String(error),
    } satisfies EarthReply);
  }
};
