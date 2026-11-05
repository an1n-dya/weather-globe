import {
  CustomBlending,
  DataTexture,
  type IUniform,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  RedFormat,
  RGBAFormat,
  ShaderMaterial,
  SphereGeometry,
  type Texture,
  type Vector3,
} from "three";
import { planetFragment, planetVertex } from "./shaders/planet";

/** Encloses the top of the atmosphere the shader integrates, at 1.068. */
const SHELL_RADIUS = 1.075;

export interface PlanetUniforms {
  [name: string]: IUniform;
  uSun: IUniform<Vector3>;
  uDay: IUniform<Texture>;
  uLights: IUniform<Texture>;
  uWater: IUniform<Texture>;
  uClouds: IUniform<Texture>;
  uNoise: IUniform<Texture>;
  uDayReady: IUniform<number>;
  uCloudAmount: IUniform<number>;
  uTime: IUniform<number>;
  uLightning: IUniform<number>;
  uDetail: IUniform<number>;
  uExposure: IUniform<number>;
  uReveal: IUniform<number>;
}

/** A one-texel stand-in until the real map arrives. */
export function solidTexture(value: number, channels: 1 | 4): Texture {
  const data = new Uint8Array(channels).fill(value);
  const texture = new DataTexture(data, 1, 1, channels === 1 ? RedFormat : RGBAFormat);
  texture.needsUpdate = true;
  return texture;
}

export function createPlanet(uniforms: PlanetUniforms, scatterSteps: number): Mesh {
  const material = new ShaderMaterial({
    vertexShader: planetVertex,
    fragmentShader: planetFragment,
    uniforms,
    defines: { STEPS: scatterSteps },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // The shader writes premultiplied color: glow adds, the planet covers.
    blending: CustomBlending,
    blendSrc: OneFactor,
    blendDst: OneMinusSrcAlphaFactor,
  });
  const mesh = new Mesh(new SphereGeometry(SHELL_RADIUS, 96, 64), material);
  mesh.renderOrder = 1;
  mesh.frustumCulled = false;
  return mesh;
}
