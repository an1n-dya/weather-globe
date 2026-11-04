import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  type IUniform,
  OneFactor,
  Points,
  ShaderMaterial,
  ZeroFactor,
} from "three";
import { dataUrl } from "../data";
import { latLonToVec3 } from "../geo/coords";
import { starsFragment, starsVertex } from "./shaders/stars";

const BYTES_PER_STAR = 8;

/** Star color from its B-V index, by way of its temperature (Ballesteros 2012). */
export function starColor(bv: number): [number, number, number] {
  const kelvin = 4600 * (1 / (0.92 * bv + 1.7) + 1 / (0.92 * bv + 0.62));
  const t = kelvin / 100;
  const red = t <= 66 ? 255 : 329.7 * (t - 60) ** -0.1332;
  const green = t <= 66 ? 99.47 * Math.log(t) - 161.12 : 288.12 * (t - 60) ** -0.0755;
  const blue = t >= 66 ? 255 : t <= 19 ? 0 : 138.52 * Math.log(t - 10) - 305.04;
  // Halfway to white: to the eye, only the strongest star colors show.
  const channel = (value: number) => 0.5 + (0.5 * Math.max(0, Math.min(255, value))) / 255;
  return [channel(red), channel(green), channel(blue)];
}

export interface StarUniforms {
  uSidereal: IUniform<number>;
  uPixelRatio: IUniform<number>;
  uReveal: IUniform<number>;
}

/** The night sky from the bright star catalog; `limit` keeps only the brightest. */
export async function loadStars(uniforms: StarUniforms, limit: number): Promise<Points> {
  const response = await fetch(dataUrl("stars.bin"));
  if (!response.ok) throw new Error(`HTTP ${response.status} for stars.bin`);
  const view = new DataView(await response.arrayBuffer());
  const count = Math.min(limit, Math.floor(view.byteLength / BYTES_PER_STAR));

  const positions = new Float32Array(count * 3);
  const colors = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const o = i * BYTES_PER_STAR;
    const ra = (view.getUint16(o, true) / 65536) * 360;
    const dec = (view.getInt16(o + 2, true) / 32767) * 90;
    const magnitude = view.getInt16(o + 4, true) / 100;
    const bv = view.getInt16(o + 6, true) / 100;
    positions.set(latLonToVec3(dec, ra), i * 3);
    const flux = 10 ** (-0.4 * (magnitude + 0.5));
    const brightness = Math.min(1, 0.07 + 2.2 * flux ** 0.5) * 0.85;
    const [r, g, b] = starColor(bv);
    colors.set([r * brightness, g * brightness, b * brightness], i * 3);
    sizes[i] = 1.9 + 2.9 * Math.min(1, flux) ** 0.5;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setAttribute("aColor", new BufferAttribute(colors, 3));
  geometry.setAttribute("aSize", new BufferAttribute(sizes, 1));
  const material = new ShaderMaterial({
    vertexShader: starsVertex,
    fragmentShader: starsFragment,
    uniforms: { ...uniforms },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Light adds up, and the canvas stays transparent around each star.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneFactor,
    blendSrcAlpha: ZeroFactor,
    blendDstAlpha: OneFactor,
  });
  const points = new Points(geometry, material);
  points.frustumCulled = false;
  points.renderOrder = 0;
  return points;
}
