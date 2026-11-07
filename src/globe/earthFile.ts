import { dataUrl } from "../data";

let pending: Promise<ArrayBuffer> | null = null;

/**
 * Downloads the globe's points, once. The app starts this as it boots, so the
 * download runs alongside three.js; the scene then picks up the same promise.
 * (A <link rel="preload"> did this too, but Safari fetched the file twice.)
 */
export function earthFile(): Promise<ArrayBuffer> {
  pending ??= fetch(dataUrl("earth.bin"))
    .then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.arrayBuffer();
    })
    .catch((error: unknown) => {
      // A later call tries again rather than repeating the failure.
      pending = null;
      throw error;
    });
  return pending;
}
