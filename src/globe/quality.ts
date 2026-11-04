/** How much the globe asks of the device. */
export interface Quality {
  level: "high" | "low";
  /** Texture size suffix in public/textures. */
  textures: "4k" | "2k";
  maxPixelRatio: number;
  /** Cloud cube face size in texels. */
  cloudFace: number;
  cloudOctaves: number;
  /** Atmosphere samples per pixel. */
  scatterSteps: number;
  /** Rain and snow particles. */
  particles: number;
}

const HIGH: Quality = {
  level: "high",
  textures: "4k",
  maxPixelRatio: 2,
  cloudFace: 512,
  cloudOctaves: 6,
  scatterSteps: 10,
  particles: 3600,
};

const LOW: Quality = {
  level: "low",
  textures: "2k",
  maxPixelRatio: 1.5,
  cloudFace: 256,
  cloudOctaves: 5,
  scatterSteps: 6,
  particles: 1600,
};

/** The detail level asked for with `?detail=low` or `?detail=high`, if any. */
export function forcedDetail(): Quality["level"] | null {
  const forced = new URLSearchParams(location.search).get("detail");
  return forced === "low" || forced === "high" ? forced : null;
}

/** A forced level overrides the guess, which favors low-end touch devices. */
export function detectQuality(maxTextureSize: number): Quality {
  const forced = forcedDetail();
  if (forced === "low") return LOW;
  if (forced === "high") return HIGH;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = matchMedia("(pointer: coarse)").matches;
  const weak = coarse && (navigator.hardwareConcurrency <= 4 || (nav.deviceMemory ?? 8) <= 3);
  return weak || maxTextureSize < 4096 ? LOW : HIGH;
}
