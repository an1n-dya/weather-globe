import {
  LinearMipmapLinearFilter,
  NoColorSpace,
  RedFormat,
  RepeatWrapping,
  SRGBColorSpace,
  Texture,
} from "three";
import { dataUrl } from "../data";

type Source = ImageBitmap | HTMLImageElement;

/** Decodes off the main thread where the browser can. */
async function loadImage(url: string): Promise<Source> {
  if (typeof createImageBitmap === "function") {
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return await createImageBitmap(await response.blob());
    } catch (error) {
      console.warn("Falling back to an image element", error);
    }
  }
  // A blob: URL would break the Content-Security-Policy, so load by address.
  const image = new Image();
  image.src = url;
  await image.decode();
  return image;
}

export interface TextureOptions {
  /** Color imagery, decoded from sRGB when sampled. */
  color?: boolean;
  anisotropy?: number;
}

/**
 * Equirectangular map with north in the first row, wrapping in longitude.
 * Data maps keep one channel, a quarter of the memory.
 */
export async function loadEquirect(file: string, options: TextureOptions = {}): Promise<Texture> {
  const texture = new Texture(await loadImage(dataUrl(file, "textures")));
  texture.flipY = false;
  texture.wrapS = RepeatWrapping;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.anisotropy = options.anisotropy ?? 1;
  if (options.color) {
    texture.colorSpace = SRGBColorSpace;
  } else {
    texture.colorSpace = NoColorSpace;
    texture.format = RedFormat;
  }
  texture.needsUpdate = true;
  return texture;
}

/** The current month's imagery, so the globe shows this season's snow and green. */
export function dayTextureFile(date: Date, size: "4k" | "2k"): string {
  return `day-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${size}.webp`;
}
