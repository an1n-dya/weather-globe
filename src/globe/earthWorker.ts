/// <reference lib="webworker" />
import { buildEarthArrays } from "./earthMesh";

export interface EarthRequest {
  frequency: number;
  mask: Uint8Array;
}

/** Builds the mesh off the main thread, as it takes over a second on a slower phone. */
self.onmessage = ({ data }: MessageEvent<EarthRequest>) => {
  const arrays = buildEarthArrays(data.frequency, data.mask);
  self.postMessage(arrays, {
    transfer: [arrays.positions.buffer, arrays.normals.buffer, arrays.colors.buffer],
  });
};
