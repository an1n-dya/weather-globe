import {
  type IUniform,
  PerspectiveCamera,
  type Points,
  Raycaster,
  Scene,
  type Texture,
  Vector2,
  Vector3,
  Vector4,
  WebGLRenderer,
} from "three";
import { DEG, latLonToVec3, vec3ToLatLon } from "../geo/coords";
import { siderealDeg, sunDirection } from "../geo/sun";
import type { Sky } from "../weather/conditions";
import { buildSkyField, type SkySample, sampleSkyField } from "../weather/field";
import { FOV, fitDistance, GlobeCameraRig, type GlobeView } from "./camera";
import { CloudLayer } from "./clouds";
import { CityMarkers, type MarkerCity, type MarkerContent, type MarkerLayout } from "./markers";
import { frameInterval, IDLE_AFTER_MS } from "./pacing";
import { NoiseVolume } from "./passes";
import { createPlanet, type PlanetUniforms, solidTexture } from "./planet";
import { Precipitation } from "./precipitation";
import { detectQuality, forcedDetail, type Quality } from "./quality";
import { loadStars } from "./stars";
import { SunGlare } from "./sunGlare";
import { dayTextureFile, loadEquirect } from "./textures";

export interface GlobeCallbacks {
  onMove(view: GlobeView): void;
  onSettle(view: GlobeView): void;
  onTapPoint(lat: number, lon: number): void;
  onTapCity(city: MarkerCity): void;
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
}

export interface GlobeSceneOptions {
  container: HTMLElement;
  markerLayer: HTMLElement;
  cities: ReadonlyArray<MarkerCity>;
  initial: { lat: number; lon: number; distance?: number };
  insets: Insets;
  callbacks: GlobeCallbacks;
  /** Interface elements floating over the globe, which markers should stay clear of. */
  obstacles: () => Element[];
}

const SETTLE_MS = 400;
const SUN_REFRESH_MS = 10_000;
const TAP_MAX_TRAVEL_PX = 6;
const TAP_MAX_MS = 400;
const ZOOM_IN_FACTOR = 0.72;
const ZOOM_OUT_FACTOR = 1.38;
const RETICLE_CLEARANCE_PX = 36;
/** Drifting cloud needs far fewer frames than a drag. */
const INTRO_MS = 1700;
const EXPOSURE = 7.5;

const TAN_HALF_FOV = Math.tan((FOV / 2) * DEG);
const SOFTWARE = /swiftshader|llvmpipe|softpipe|software/i;

/** Graphics without a GPU behind them, where every pixel costs the CPU. */
function isSoftwareRenderer(renderer: WebGLRenderer): boolean {
  const gl = renderer.getContext();
  const name = String(gl.getParameter(gl.RENDERER));
  if (SOFTWARE.test(name)) return true;
  // Chrome and Safari only name the real renderer through this extension.
  if (!/webkit/i.test(name)) return false;
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  return info !== null && SOFTWARE.test(String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)));
}

/** Eases a value toward a target, independent of frame rate. */
class Tween {
  constructor(
    readonly uniform: IUniform<number>,
    public target: number,
    private readonly seconds: number,
  ) {}

  /** Returns whether it is still moving. */
  step(dt: number): boolean {
    const { value } = this.uniform;
    if (value === this.target) return false;
    const next = value + (this.target - value) * (1 - Math.exp(-dt / (this.seconds / 4)));
    this.uniform.value = Math.abs(next - this.target) < 0.002 ? this.target : next;
    return true;
  }

  finish(): void {
    this.uniform.value = this.target;
  }
}

export class GlobeScene {
  private readonly container: HTMLElement;
  private readonly initial: GlobeSceneOptions["initial"];
  private readonly callbacks: GlobeCallbacks;
  private readonly obstacles: () => Element[];
  private insets: Insets;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly rig: GlobeCameraRig;
  private readonly markers: CityMarkers;
  private readonly raycaster = new Raycaster();
  private readonly quality: Quality;
  private readonly software: boolean;
  private readonly motion: boolean;
  private readonly noise: NoiseVolume;
  private readonly clouds: CloudLayer;
  private readonly precipitation: Precipitation;
  private readonly glare: SunGlare;
  private readonly uniforms: PlanetUniforms;
  private readonly starUniforms = {
    uSidereal: { value: 0 },
    uPixelRatio: { value: 1 },
    uReveal: { value: 0 },
  };
  private readonly tweens: Tween[];
  private readonly revealTween: Tween;
  private readonly cloudTween: Tween;
  private readonly dayTween: Tween;
  private readonly resizeObserver: ResizeObserver;
  private readonly viewDir = new Vector3();
  private pixelRatio: number;
  private maxPixelRatio: number;
  private frame = 0;
  private disposed = false;
  private dirty = true;
  private positioned = false;
  private readonly lastPosition = new Vector3();
  private readonly previousPosition = new Vector3();
  private lastMoveAt = Number.NEGATIVE_INFINITY;
  private settled = false;
  private lastSunAt = Number.NEGATIVE_INFINITY;
  private lastTickAt = 0;
  private lastDrawAt = Number.NEGATIVE_INFINITY;
  private lastActiveAt = 0;
  private time = 0;
  private intro: { until: number; interactions: number } | null = null;
  private revealed = false;
  private field: Uint8Array;
  private localSky: { dir: Vector3; precip: number } | null = null;
  private nearbyStale = true;
  private markersStale = true;
  private cloudsFilled = false;
  private pace = { since: 0, frames: 0, total: 0, changedAt: 0 };
  private width = 1;
  private height = 1;
  private markerLayout: MarkerLayout = { width: 1, height: 1, area: [0, 0, 1, 1], blocked: [] };
  private tapStart: { x: number; y: number; time: number; pointerId: number } | null = null;

  /** Throws if WebGL is unavailable, so callers can fall back to the panel alone. */
  constructor(options: GlobeSceneOptions) {
    this.container = options.container;
    this.initial = options.initial;
    this.insets = options.insets;
    this.callbacks = options.callbacks;
    this.obstacles = options.obstacles;

    this.renderer = new WebGLRenderer({ antialias: false, alpha: true });
    this.software = isSoftwareRenderer(this.renderer);
    this.quality = detectQuality(this.renderer.capabilities.maxTextureSize);
    // Without a GPU every pixel costs the CPU: half resolution, and the lightest
    // work, unless full detail was asked for.
    if (this.software && forcedDetail() !== "high") {
      this.quality = {
        ...this.quality,
        maxPixelRatio: 0.5,
        scatterSteps: 4,
        cloudFace: 256,
        cloudOctaves: 4,
        particles: 900,
      };
    }
    this.maxPixelRatio = Math.min(window.devicePixelRatio || 1, this.quality.maxPixelRatio);
    this.pixelRatio = this.maxPixelRatio;
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.starUniforms.uPixelRatio.value = this.pixelRatio;

    const dom = this.renderer.domElement;
    dom.tabIndex = 0;
    dom.setAttribute("role", "application");
    dom.setAttribute(
      "aria-label",
      "Globe. Use the arrow keys to rotate and plus or minus to zoom.",
    );
    this.container.append(dom);

    this.camera = new PerspectiveCamera(FOV, 1, 0.02, 60);
    const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.motion = !reducedMotion;
    this.rig = new GlobeCameraRig(this.camera, dom, reducedMotion);
    this.markers = new CityMarkers(options.markerLayer, options.cities);

    this.noise = new NoiseVolume();
    this.noise.build(this.renderer);
    this.field = buildSkyField([], new Date());
    this.clouds = new CloudLayer(this.noise.texture, new Uint8Array(this.field), this.quality);
    this.uniforms = {
      uSun: { value: new Vector3(0, 0, 1) },
      uDay: { value: solidTexture(0, 4) },
      uLights: { value: solidTexture(0, 1) },
      uWater: { value: solidTexture(255, 1) },
      uClouds: { value: this.clouds.texture },
      uNoise: { value: this.noise.texture },
      uDayReady: { value: 0 },
      uCloudAmount: { value: 1 },
      uTime: { value: 0 },
      uLightning: { value: this.motion ? 1 : 0 },
      uDetail: { value: 0 },
      uExposure: { value: EXPOSURE },
      uReveal: { value: this.motion ? 0 : 1 },
    };
    this.scene.add(createPlanet(this.uniforms, this.quality.scatterSteps));
    this.precipitation = new Precipitation(this.uniforms, this.quality.particles);
    this.scene.add(this.precipitation.mesh);
    this.glare = new SunGlare(this.uniforms.uSun, this.uniforms.uReveal);
    this.scene.add(this.glare.mesh);

    this.revealTween = new Tween(this.uniforms.uReveal, this.uniforms.uReveal.value, 1.1);
    this.cloudTween = new Tween(this.uniforms.uCloudAmount, 1, 0.7);
    this.dayTween = new Tween(this.uniforms.uDayReady, 0, 0.8);
    this.tweens = [this.revealTween, this.cloudTween, this.dayTween];
    this.starUniforms.uReveal = this.uniforms.uReveal;

    void this.loadTextures();
    // On a slow connection, show the plain globe rather than nothing.
    setTimeout(() => this.startReveal(), 600);
    void loadStars(this.starUniforms, this.quality.level === "high" ? 9100 : 4000)
      .then((stars) => {
        if (this.disposed) return;
        this.scene.add(stars);
        this.dirty = true;
      })
      .catch((error: unknown) => console.warn("Could not load stars", error));

    dom.addEventListener("pointerdown", this.handlePointerDown);
    dom.addEventListener("wheel", this.markActive, { passive: true });
    window.addEventListener("focus", this.markActive);
    dom.addEventListener("pointerup", this.handlePointerUp);
    dom.addEventListener("pointercancel", this.handlePointerCancel);
    dom.addEventListener("keydown", this.handleKeyDown);
    dom.addEventListener("webglcontextrestored", this.handleContextRestored);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.resize();
    this.frame = requestAnimationFrame(this.tick);
  }

  /** A closer view for arriving at a named place; never zooms back out. */
  get arrivalDistance(): number {
    return Math.min(this.rig.view.distance, 2.1);
  }

  flyTo(lat: number, lon: number, distance?: number): void {
    this.endIntro();
    this.rig.flyTo({ lat, lon, distance }, performance.now());
  }

  zoomBy(factor: number): void {
    this.endIntro();
    this.rig.zoomBy(factor, performance.now());
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
    this.resize();
  }

  setCityWeather(contentFor: (city: MarkerCity) => MarkerContent | null): void {
    this.markers.setContent(contentFor);
    this.markersStale = true;
    this.dirty = true;
  }

  /** Current conditions around the world, which shape the cloud layer. */
  setSkySamples(samples: ReadonlyArray<SkySample>): void {
    this.field = buildSkyField(samples, new Date());
    this.clouds.setField(new Uint8Array(this.field), !this.motion);
    this.nearbyStale = true;
    this.dirty = true;
  }

  /** The selected place's forecast, so the sky over it matches the panel. */
  setLocalSky(
    place: {
      lat: number;
      lon: number;
      sky: Sky;
      windDirection: number | null;
      wind: number;
    } | null,
  ): void {
    if (!place) {
      this.clouds.setSpot(null, new Vector4(), !this.motion);
      this.localSky = null;
    } else {
      const { sky } = place;
      const dir = new Vector3(...latLonToVec3(place.lat, place.lon));
      this.clouds.setSpot(
        dir,
        new Vector4(sky.cloud, sky.precip, sky.snow, sky.thunder),
        !this.motion,
      );
      this.precipitation.setWind(place.windDirection, place.wind);
      this.precipitation.setFog(sky.fog, dir);
      this.localSky = { dir, precip: sky.precip };
    }
    this.nearbyStale = true;
    this.dirty = true;
  }

  setWeatherVisible(visible: boolean): void {
    this.cloudTween.target = visible ? 1 : 0;
    if (!this.motion) this.cloudTween.finish();
    this.dirty = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.handlePointerDown);
    dom.removeEventListener("wheel", this.markActive);
    window.removeEventListener("focus", this.markActive);
    dom.removeEventListener("pointerup", this.handlePointerUp);
    dom.removeEventListener("pointercancel", this.handlePointerCancel);
    dom.removeEventListener("keydown", this.handleKeyDown);
    dom.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.rig.dispose();
    this.markers.dispose();
    this.scene.traverse((object) => {
      const { geometry, material } = object as Partial<Points>;
      geometry?.dispose();
      if (material && !Array.isArray(material)) material.dispose();
    });
    for (const name of ["uDay", "uLights", "uWater"] as const) this.uniforms[name].value.dispose();
    this.clouds.dispose();
    this.noise.dispose();
    this.renderer.dispose();
    dom.remove();
  }

  /** The 2k maps first, so the globe appears quickly, then 4k where the device can use it. */
  private async loadTextures(): Promise<void> {
    const anisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const sizes = this.quality.textures === "4k" ? (["2k", "4k"] as const) : (["2k"] as const);
    for (const size of sizes) {
      try {
        const [day, lights, water] = await Promise.all([
          loadEquirect(dayTextureFile(new Date(), size), { color: true, anisotropy }),
          loadEquirect(`lights-${size}.webp`),
          loadEquirect(`water-${size}.webp`),
        ]);
        if (this.disposed) {
          for (const texture of [day, lights, water]) texture.dispose();
          return;
        }
        this.swapTexture("uDay", day);
        this.swapTexture("uLights", lights);
        this.swapTexture("uWater", water);
        this.dayTween.target = 1;
        if (!this.motion) this.dayTween.finish();
        this.startReveal();
        this.dirty = true;
      } catch (error) {
        // Whatever loaded stays, or the plain ocean; time and weather are unaffected.
        console.warn(`Could not load ${size} textures`, error);
        this.startReveal();
        break;
      }
    }
    // For tests: no more texture loads will change the picture.
    if (!this.disposed) this.container.dataset.globe = "ready";
  }

  private swapTexture(name: "uDay" | "uLights" | "uWater", texture: Texture): void {
    const old = this.uniforms[name].value;
    this.renderer.initTexture(texture);
    this.uniforms[name].value = texture;
    old.dispose();
  }

  private startReveal(): void {
    if (this.disposed || this.revealed) return;
    this.revealed = true;
    this.revealTween.target = 1;
    this.markers.reveal();
  }

  private endIntro(): void {
    if (!this.intro) return;
    this.intro = null;
    this.startReveal();
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);

    const { top, right, bottom } = this.insets;
    const freeWidth = Math.max(120, width - right);
    const freeHeight = Math.max(120, height - top - bottom);
    const offsetX = right / 2;
    const offsetY = (bottom - top) / 2;
    this.camera.aspect = width / height;
    this.camera.setViewOffset(width, height, offsetX, offsetY, width, height);

    const centerX = width / 2 - offsetX;
    const centerY = height / 2 - offsetY;
    this.container.style.setProperty("--globe-x", `${centerX}px`);
    this.container.style.setProperty("--globe-y", `${centerY}px`);

    const origin = this.container.getBoundingClientRect();
    this.markerLayout = {
      width,
      height,
      area: [0, top, width - right, height - bottom],
      blocked: [
        [
          centerX - RETICLE_CLEARANCE_PX,
          centerY - RETICLE_CLEARANCE_PX,
          centerX + RETICLE_CLEARANCE_PX,
          centerY + RETICLE_CLEARANCE_PX,
        ],
        ...this.obstacles().map((element) => {
          const rect = element.getBoundingClientRect();
          return [
            rect.left - origin.left,
            rect.top - origin.top,
            rect.right - origin.left,
            rect.bottom - origin.top,
          ] as const;
        }),
      ],
    };

    const fit = fitDistance(Math.min(freeWidth, freeHeight), height);
    this.rig.setMaxDistance(fit * 1.04);

    // The fitted distance needs a real size, and a page opened in a hidden
    // window has none until it is first shown.
    if (!this.positioned) {
      this.positioned = true;
      const view = {
        lat: this.initial.lat,
        lon: this.initial.lon,
        distance: Math.min(this.initial.distance ?? Number.POSITIVE_INFINITY, this.rig.maxDistance),
      };
      this.rig.jumpTo(view);
      if (this.motion) {
        // Arriving from further out isn't a move. Only the distance changes,
        // so the place is settled from the start and callbacks wait for the
        // intro to end, or for the user to take over.
        const now = performance.now();
        this.rig.arrive(view, 1 + (view.distance - 1) * 1.45, INTRO_MS, now);
        this.intro = { until: now + INTRO_MS, interactions: this.rig.interactions };
        this.settled = true;
        this.callbacks.onSettle({ ...this.rig.view, distance: view.distance });
      }
      this.lastPosition.copy(this.camera.position);
      this.previousPosition.copy(this.camera.position);
    }
    this.precipitation.resize(width, height);
    this.markersStale = true;
    this.dirty = true;
  }

  /** How hard it falls near the middle of the view, for pacing frames. */
  private updateNearby(): void {
    const { lat, lon, distance } = this.rig.view;
    const radius = Math.min(25, (TAN_HALF_FOV * (distance - 1) * 180) / Math.PI);
    const lonScale = 1 / Math.max(0.2, Math.cos(lat * DEG));
    let most = 0;
    for (const [dLat, dLon] of [
      [0, 0],
      [0.6, 0],
      [-0.6, 0],
      [0, 0.6],
      [0, -0.6],
    ] as const) {
      const sample = sampleSkyField(
        this.field,
        lat + dLat * radius,
        lon + dLon * radius * lonScale,
      );
      most = Math.max(most, sample.precip);
    }
    if (this.localSky && this.localSky.dir.dot(this.viewDir) > Math.cos((radius + 4) * DEG)) {
      most = Math.max(most, this.localSky.precip);
    }
    this.precipitation.nearby = most;
    this.nearbyStale = false;
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.positioned) return;
    const dt = Math.min(0.1, Math.max(0, (now - this.lastTickAt) / 1000));
    this.lastTickAt = now;
    this.rig.update(now);

    if (
      this.intro &&
      (now >= this.intro.until || this.rig.interactions > this.intro.interactions)
    ) {
      this.endIntro();
    }

    if (now - this.lastSunAt > SUN_REFRESH_MS) {
      this.lastSunAt = now;
      const date = new Date();
      this.uniforms.uSun.value.set(...sunDirection(date));
      this.starUniforms.uSidereal.value = siderealDeg(date) * DEG;
      this.dirty = true;
    }

    // Motion under a twentieth of a pixel isn't a move. The tail of a drag's
    // damping lasts about a hundred frames, which on a slow device would hold
    // back settling, and the weather, for many seconds after the globe looks still.
    const distance = this.camera.position.length();
    const pixel = (2 * TAN_HALF_FOV * (distance - 1)) / this.height;
    const step = this.camera.position.distanceTo(this.previousPosition);
    this.previousPosition.copy(this.camera.position);
    const moved =
      step > distance * pixel * 0.05 &&
      this.camera.position.distanceToSquared(this.lastPosition) > 1e-12;
    if (moved) {
      this.lastPosition.copy(this.camera.position);
      this.lastMoveAt = now;
      this.dirty = true;
      this.markersStale = true;
      this.nearbyStale = true;
      if (!this.intro) {
        this.settled = false;
        this.callbacks.onMove(this.rig.view);
      }
    } else if (!this.settled && !this.intro && now - this.lastMoveAt >= SETTLE_MS) {
      this.settled = true;
      this.callbacks.onSettle(this.rig.view);
    }

    let tweening = false;
    for (const tween of this.tweens) tweening = tween.step(dt) || tweening;

    // Frames are drawn on change; with motion allowed, the sky also drifts.
    if (moved || this.rig.flying) this.lastActiveAt = now;
    const busy = moved || tweening || this.clouds.transitioning;
    const interval = frameInterval({
      motion: this.motion,
      software: this.software,
      // A window in the background is idle too, unless something is moving it.
      idle: now - this.lastActiveAt > IDLE_AFTER_MS || (!moved && !document.hasFocus()),
      busy,
      falling: this.precipitation.active,
    });
    const due = this.dirty || now - this.lastDrawAt >= interval - 2;
    if (!due) return;

    const sinceDraw = Math.min(0.1, (now - this.lastDrawAt) / 1000);
    // Real seconds, so drifting cloud keeps its pace whatever the frame rate.
    if (this.motion) this.time = now / 1000;
    this.uniforms.uTime.value = this.time;
    this.viewDir.copy(this.camera.position).normalize();
    const altitude = this.camera.position.length() - 1;
    this.uniforms.uDetail.value = Math.max(0, Math.min(1, (0.85 - altitude) / 0.6));
    // The first fill draws every face at once, so no face starts out empty.
    const faces = this.motion && this.cloudsFilled ? 1 : 6;
    this.clouds.update(this.renderer, this.time, sinceDraw, this.viewDir, faces);
    this.cloudsFilled = true;
    if (this.nearbyStale) this.updateNearby();
    this.precipitation.update(
      this.camera,
      this.rig.view,
      this.time,
      this.uniforms.uCloudAmount.value,
    );
    this.glare.update(this.camera);

    this.pacePixelRatio(now, busy || this.precipitation.active);
    this.dirty = false;
    this.lastDrawAt = now;
    if (this.markersStale) {
      this.markersStale = false;
      this.markers.update(this.camera, this.markerLayout);
    }
    this.renderer.render(this.scene, this.camera);
  };

  /**
   * Lowers the resolution when drawing can't keep up while the globe moves,
   * and restores it after a while of keeping up easily.
   */
  private pacePixelRatio(now: number, busy: boolean): void {
    const pace = this.pace;
    if (!busy || this.software) {
      pace.frames = 0;
      pace.total = 0;
      pace.since = now;
      return;
    }
    pace.frames++;
    pace.total = now - pace.since;
    if (pace.frames < 45) return;
    const frameMs = pace.total / pace.frames;
    pace.frames = 0;
    pace.since = now;
    let next = this.pixelRatio;
    if (frameMs > 24) next = Math.max(1, this.pixelRatio * 0.8);
    else if (frameMs < 17.5 && now - pace.changedAt > 6000)
      next = Math.min(this.maxPixelRatio, this.pixelRatio * 1.15);
    if (Math.abs(next - this.pixelRatio) < 0.01) return;
    pace.changedAt = now;
    this.pixelRatio = next;
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(this.width, this.height);
    this.starUniforms.uPixelRatio.value = next;
    this.precipitation.resize(this.width, this.height);
  }

  /**
   * Phones can drop the GPU context in the background. A restored canvas
   * starts out blank, and the noise and cloud maps drawn on the GPU are gone.
   */
  private handleContextRestored = (): void => {
    this.noise.build(this.renderer);
    this.clouds.invalidate();
    this.cloudsFilled = false;
    this.dirty = true;
  };

  /** Input of any kind brings the globe back to full pace. */
  private markActive = (): void => {
    this.lastActiveAt = performance.now();
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    this.markActive();
    // Leaves browser shortcuts alone, such as Ctrl+minus and Alt+Left.
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const now = performance.now();
    switch (event.key) {
      case "ArrowUp":
        this.rig.nudge(1, 0, now);
        break;
      case "ArrowDown":
        this.rig.nudge(-1, 0, now);
        break;
      case "ArrowLeft":
        this.rig.nudge(0, -1, now);
        break;
      case "ArrowRight":
        this.rig.nudge(0, 1, now);
        break;
      case "+":
      case "=":
        this.rig.zoomBy(ZOOM_IN_FACTOR, now);
        break;
      case "-":
        this.rig.zoomBy(ZOOM_OUT_FACTOR, now);
        break;
      default:
        return;
    }
    this.endIntro();
    event.preventDefault();
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.markActive();
    // A second finger is a pinch, and other mouse buttons aren't taps.
    this.tapStart =
      event.isPrimary && event.button === 0
        ? {
            x: event.clientX,
            y: event.clientY,
            time: performance.now(),
            pointerId: event.pointerId,
          }
        : null;
  };

  private handlePointerCancel = (): void => {
    this.tapStart = null;
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const start = this.tapStart;
    this.tapStart = null;
    if (start?.pointerId !== event.pointerId) return;
    const travel = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (travel > TAP_MAX_TRAVEL_PX || performance.now() - start.time > TAP_MAX_MS) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const city = this.markers.pick(x, y);
    if (city) {
      this.endIntro();
      this.callbacks.onTapCity(city);
      return;
    }
    const point = this.intersectGlobe(x, y);
    if (point) {
      this.endIntro();
      this.callbacks.onTapPoint(point.lat, point.lon);
    }
  };

  /** Analytic ray and unit sphere intersection. */
  private intersectGlobe(x: number, y: number): { lat: number; lon: number } | null {
    const ndc = new Vector2((x / this.width) * 2 - 1, 1 - (y / this.height) * 2);
    this.raycaster.setFromCamera(ndc, this.camera);
    const { origin, direction } = this.raycaster.ray;
    const b = origin.dot(direction);
    const c = origin.lengthSq() - 1;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const t = -b - Math.sqrt(discriminant);
    const hit = origin.clone().addScaledVector(direction, t);
    return vec3ToLatLon(hit.x, hit.y, hit.z);
  }
}
