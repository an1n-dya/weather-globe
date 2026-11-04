import {
  BufferAttribute,
  BufferGeometry,
  CustomBlending,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  OneFactor,
  OneMinusSrcAlphaFactor,
  type PerspectiveCamera,
  ShaderMaterial,
  Vector2,
  Vector3,
} from "three";
import { DEG, lonDelta } from "../geo/coords";
import type { GlobeView } from "./camera";
import { FOV } from "./camera";
import type { PlanetUniforms } from "./planet";
import { fullscreenVertex } from "./shaders/common";
import { fogFragment, precipitationFragment, precipitationVertex } from "./shaders/precipitation";

const TAN_HALF_FOV = Math.tan((FOV / 2) * DEG);
/** Altitudes, in planet radii, over which rain grows from specks to streaks. */
const FAR_ALTITUDE = 1.6;
const NEAR_ALTITUDE = 0.2;
const PARTICLE_PERIOD_S = 300;

function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const blending = {
  side: DoubleSide,
  transparent: true,
  depthTest: false,
  depthWrite: false,
  blending: CustomBlending,
  blendSrc: OneFactor,
  blendDst: OneMinusSrcAlphaFactor,
} as const;

/**
 * Falling rain and snow, plus mist close over fog. Particles ride along when
 * the globe turns, nearer ones more, so they seem to hang in the air above it.
 */
export class Precipitation {
  readonly mesh = new Group();
  private readonly inverse = new Matrix4();
  private readonly offset = new Vector2();
  private readonly resolution = new Vector2(1, 1);
  private readonly wind = new Vector2(0.06, 0);
  private readonly time = { value: 0 };
  private readonly closeness = { value: 0 };
  private readonly amount = { value: 0 };
  private readonly fogStrength = { value: 0 };
  private readonly fogDir = new Vector3();
  private readonly viewDir = new Vector3();
  private fogAmount = 0;
  private last: GlobeView | null = null;
  private visible = 0;
  /** Strongest precipitation near the middle of the view, from the scene's weather data. */
  nearby = 0;

  constructor(planet: PlanetUniforms, count: number) {
    const next = random(7);
    const seeds = new Float32Array(count * 4);
    const thresholds = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      seeds.set([next(), next(), next() ** 0.7, next()], i * 4);
      thresholds[i] = 0.02 + next() * 0.7;
    }
    const geometry = new InstancedBufferGeometry();
    geometry.setAttribute(
      "corner",
      new Float32BufferAttribute([-0.5, -0.5, 0.5, -0.5, 0.5, 0.5, -0.5, 0.5], 2),
    );
    // The shader places every vertex itself; three.js still wants positions.
    geometry.setAttribute("position", new Float32BufferAttribute(new Float32Array(12), 3));
    geometry.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    geometry.setAttribute("aSeed", new InstancedBufferAttribute(seeds, 4));
    geometry.setAttribute("aThreshold", new InstancedBufferAttribute(thresholds, 1));
    geometry.instanceCount = count;

    const particles = new Mesh(
      geometry,
      new ShaderMaterial({
        vertexShader: precipitationVertex,
        fragmentShader: precipitationFragment,
        uniforms: {
          uClouds: planet.uClouds,
          uSun: planet.uSun,
          uInverseViewProjection: { value: this.inverse },
          uResolution: { value: this.resolution },
          uTime: this.time,
          uOffset: { value: this.offset },
          uWind: { value: this.wind },
          uCloseness: this.closeness,
          uAmount: this.amount,
        },
        ...blending,
      }),
    );
    particles.frustumCulled = false;
    particles.renderOrder = 2;

    const quad = new BufferGeometry();
    quad.setAttribute("position", new Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    const mist = new Mesh(
      quad,
      new ShaderMaterial({
        vertexShader: fullscreenVertex,
        fragmentShader: fogFragment,
        uniforms: {
          uNoise: planet.uNoise,
          uResolution: { value: this.resolution },
          uTime: planet.uTime,
          uFog: this.fogStrength,
          uOffset: { value: this.offset },
        },
        ...blending,
      }),
    );
    mist.frustumCulled = false;
    mist.renderOrder = 3;
    this.mesh.add(particles, mist);
  }

  /** Whether close-up particles are falling, which needs every frame drawn to look smooth. */
  get active(): boolean {
    return this.visible > 0.3 && this.nearby > 0.02;
  }

  /** Slants rain away from where the wind blows from, given in km/h. */
  setWind(fromDeg: number | null, speed: number): void {
    if (fromDeg === null) {
      this.wind.set(0.06, 0);
      return;
    }
    // North is up, so only the east-west part shows as a slant.
    const towardEast = -Math.sin(fromDeg * DEG);
    this.wind.set(towardEast * Math.min(0.45, speed / 90), 0);
  }

  setFog(amount: number, dir: Vector3): void {
    this.fogAmount = amount;
    this.fogDir.copy(dir);
  }

  resize(width: number, height: number): void {
    this.resolution.set(width, height);
  }

  update(camera: PerspectiveCamera, view: GlobeView, time: number, amount: number): void {
    this.inverse.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
    // Fast particles travel far: wrapping keeps their positions precise in
    // 32-bit floats. Rain is random enough that the reshuffle never shows.
    this.time.value = time % PARTICLE_PERIOD_S;

    // How far the ground under the view center moved on screen since last frame.
    const altitude = view.distance - 1;
    const screenDegrees = (2 * TAN_HALF_FOV * altitude * 180) / Math.PI;
    if (this.last) {
      const dLon = lonDelta(this.last.lon, view.lon) * Math.cos(view.lat * DEG);
      const dLat = view.lat - this.last.lat;
      const aspect = this.resolution.y / this.resolution.x;
      this.offset.x = (this.offset.x - (dLon / screenDegrees) * aspect) % 1;
      this.offset.y = (this.offset.y - dLat / screenDegrees) % 1;
    }
    this.last = view;

    const closeness = (FAR_ALTITUDE - altitude) / (FAR_ALTITUDE - NEAR_ALTITUDE);
    this.closeness.value = Math.max(0, Math.min(1, closeness));
    this.amount.value = amount;
    this.visible = amount * this.closeness.value;

    const facing = this.fogDir.dot(this.viewDir.copy(camera.position).normalize());
    const near = Math.max(0, Math.min(1, (0.9 - altitude) / 0.6));
    const over = Math.max(0, Math.min(1, (facing - 0.996) / 0.003));
    this.fogStrength.value = this.fogAmount * near * over * amount;
  }
}
