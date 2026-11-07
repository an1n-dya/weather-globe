/// <reference lib="webworker" />
import { createInflater } from "../inflate";
import { type DetailTier, EarthDecoder } from "./earthData";
import { buildEarthArrays, type EarthArrays } from "./earthMesh";

/**
 * Messages to the worker: the page's time (for the season's snow and ice), the
 * compressed file in pieces as it downloads, its end, and which tier to finish
 * with once the scene knows.
 */
export type EarthCommand =
  | { now: number }
  | { chunk: Uint8Array<ArrayBuffer> }
  | { end: true }
  | { final: DetailTier };

export type EarthReply =
  | { tier: DetailTier; arrays: EarthArrays; faces: number }
  | { done: true }
  | { error: string };

const decoder = new EarthDecoder();
let final: DetailTier | null = null;
let now = Date.now();
let sentLow = false;
let finished = false;
let failed = false;

function reply(message: EarthReply, arrays?: EarthArrays): void {
  self.postMessage(message, {
    transfer: arrays ? [arrays.positions.buffer, arrays.colors.buffer] : [],
  });
}

function fail(error: unknown): void {
  if (failed || finished) return;
  failed = true;
  reply({ error: error instanceof Error ? error.message : String(error) });
}

function send(tier: DetailTier): void {
  const points = decoder.points;
  if (!points) return;
  const arrays = buildEarthArrays(points, points.header.tiers[tier], new Date(now));
  reply({ tier, arrays, faces: arrays.positions.length / 9 }, arrays);
}

/** Builds whatever the points decoded so far allow: the light globe first, then the final one. */
function build(): void {
  const points = decoder.points;
  if (!points || failed || finished) return;
  const { tiers } = points.header;
  if (!sentLow && decoder.decoded >= tiers.low) {
    send("low");
    sentLow = true;
  }
  if (!sentLow || final === null) return;
  if (final !== "low") {
    if (decoder.decoded < tiers[final]) return;
    send(final);
  }
  finished = true;
  reply({ done: true });
}

const inflater = createInflater((chunk) => {
  try {
    decoder.push(chunk);
    build();
  } catch (error) {
    fail(error);
  }
});

/** Decoding and triangulating take a while on a phone, so they happen here, as the file arrives. */
self.onmessage = async ({ data }: MessageEvent<EarthCommand>) => {
  try {
    if ("now" in data) {
      now = data.now;
    } else if ("chunk" in data) {
      (await inflater).push(data.chunk);
    } else if ("end" in data) {
      await (await inflater).end();
      // Throws if the file stopped short.
      decoder.finish();
      build();
    } else {
      final = data.final;
      build();
    }
  } catch (error) {
    fail(error);
  }
};
