import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  type Material,
  Mesh,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from "three";
import { latLonToVec3, vec3ToLatLon } from "../geo/coords";
import { sunDirection } from "../geo/sun";
import { FOV, fitDistance, GlobeCameraRig, type GlobeView } from "./camera";
import type { DetailTier } from "./earthData";
import { earthFile } from "./earthFile";
import type { EarthArrays } from "./earthMesh";
import type { EarthReply, EarthRequest } from "./earthWorker";
import { CityMarkers, type MarkerCity, type MarkerContent, type MarkerLayout } from "./markers";
import {
  atmosphereFragment,
  atmosphereVertex,
  earthFragment,
  earthVertex,
  lightsFragment,
  lightsVertex,
  starsFragment,
  starsVertex,
} from "./shaders";

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

export interface LightPoint {
  lat: number;
  lon: number;
  pop: number;
}

/** How long the view must stay still before it counts as settled. */
const SETTLE_MS = 350;
const SUN_REFRESH_MS = 30_000;
/** Just above the land, so lights aren't buried in it. */
const LIGHT_RADIUS = 1.004;
const ZOOM_IN_FACTOR = 0.72;
const ZOOM_OUT_FACTOR = 1.38;
const DOUBLE_TAP_ZOOM = 0.45;
const RETICLE_CLEARANCE_PX = 36;
/** How long a newly built globe takes to fade in over the one before. */
const FADE_MS = 450;
/** The plain ocean shown until the land arrives. */
const PLACEHOLDER_COLOR = [27, 104, 186, 255] as const;

/**
 * low: about 25,000 faces, for weak phones. medium: about 84,000, for other
 * touch devices. high: about 175,000, for everything else. ?detail= overrides.
 */
export function detailTier(): DetailTier {
  const forced = new URLSearchParams(location.search).get("detail");
  if (forced === "low" || forced === "medium" || forced === "high") return forced;
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = matchMedia("(pointer: coarse)").matches;
  if (coarse && (navigator.hardwareConcurrency <= 4 || (nav.deviceMemory ?? 8) <= 3)) return "low";
  return coarse ? "medium" : "high";
}

/** Builds each tier in a worker, calling back as each is ready. */
function buildEarthInWorker(
  request: EarthRequest,
  onTier: (tier: DetailTier, arrays: EarthArrays) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./earthWorker.ts", import.meta.url), { type: "module" });
    let remaining = request.tiers.length;
    worker.onmessage = ({ data }: MessageEvent<EarthReply>) => {
      if ("error" in data) {
        worker.terminate();
        reject(new Error(data.error));
        return;
      }
      onTier(data.tier, data.arrays);
      remaining--;
      if (remaining === 0) {
        worker.terminate();
        resolve();
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || "The globe worker failed"));
    };
    worker.postMessage(request, [request.file]);
  });
}

interface Fade {
  mesh: Mesh<BufferGeometry, ShaderMaterial>;
  opacity: { value: number };
  start: number | null;
  final: boolean;
  faces: number;
}

export class GlobeScene {
  private readonly container: HTMLElement;
  private readonly initial: GlobeSceneOptions["initial"];
  private readonly callbacks: GlobeCallbacks;
  private readonly obstacles: () => Element[];
  private insets: Insets;
  private targetInsets: Insets;
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly rig: GlobeCameraRig;
  private readonly markers: CityMarkers;
  private readonly sunUniform = { value: new Vector3(0, 0, 1) };
  private readonly pixelRatioUniform = { value: 1 };
  private readonly lightScale = { value: 1 };
  private readonly lightThreshold = { value: 5 };
  private readonly raycaster = new Raycaster();
  private readonly detail = detailTier();
  private readonly reducedMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  private readonly resizeObserver: ResizeObserver;
  private readonly sunTimer: ReturnType<typeof setInterval>;
  private pixelRatioQuery: MediaQueryList | null = null;
  private frame = 0;
  private settleTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private dirty = true;
  private positioned = false;
  private settleOnFirstFrame = false;
  private readonly lastPosition = new Vector3();
  private settled = false;
  private width = 1;
  private height = 1;
  private markerLayout: MarkerLayout = { width: 1, height: 1, area: [0, 0, 1, 1], blocked: [] };
  private lastTapPoint: { lat: number; lon: number } | null = null;
  private lights: Points | null = null;
  /** The globe on screen, and the next one fading in over it. */
  private earth: Mesh<BufferGeometry, ShaderMaterial> | null = null;
  private fades: Fade[] = [];

  /** Throws if WebGL is unavailable, so callers can fall back to the panel alone. */
  constructor(options: GlobeSceneOptions) {
    this.container = options.container;
    this.initial = options.initial;
    this.insets = options.insets;
    this.targetInsets = options.insets;
    this.callbacks = options.callbacks;
    this.obstacles = options.obstacles;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.applyPixelRatio();

    const dom = this.renderer.domElement;
    dom.tabIndex = 0;
    dom.setAttribute("role", "application");
    dom.setAttribute(
      "aria-label",
      "Globe. Use the arrow keys to rotate and plus or minus to zoom.",
    );
    this.container.append(dom);

    this.camera = new PerspectiveCamera(FOV, 1, 0.02, 60);
    this.rig = new GlobeCameraRig(this.camera, dom, this.reducedMotion, {
      wake: this.requestRender,
      tap: this.handleTap,
      doubleTap: this.handleDoubleTap,
    });
    this.markers = new CityMarkers(options.markerLayer, options.cities);

    this.addPlaceholder();
    this.addAtmosphere();
    this.addStars();
    void this.loadEarth();

    dom.addEventListener("keydown", this.handleKeyDown);
    dom.addEventListener("webglcontextrestored", this.handleContextRestored);
    document.addEventListener("visibilitychange", this.handleVisibilityChange);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(this.container);
    this.sunTimer = setInterval(this.refreshSun, SUN_REFRESH_MS);
    this.refreshSun();
    this.watchPixelRatio();
    this.resize();
  }

  /** A closer view for arriving at a named place; never zooms back out. */
  get arrivalDistance(): number {
    return Math.min(this.rig.view.distance, 2.1);
  }

  flyTo(lat: number, lon: number, distance?: number): void {
    this.rig.flyTo({ lat, lon, distance }, performance.now());
  }

  /** Back out to the whole globe. */
  resetView(lat: number, lon: number): void {
    this.rig.flyTo({ lat, lon, distance: this.rig.maxDistance }, performance.now());
  }

  zoomBy(factor: number): void {
    this.rig.zoomBy(factor, performance.now());
  }

  /** The parts of the screen covered by the panel or sheet. Changes ease in. */
  setInsets(insets: Insets): void {
    this.targetInsets = insets;
    if (this.reducedMotion || !this.positioned) {
      this.insets = insets;
      this.layout();
    }
    this.requestRender();
  }

  setCityWeather(contentFor: (city: MarkerCity) => MarkerContent | null): void {
    this.markers.setContent(contentFor);
    this.dirty = true;
    this.requestRender();
  }

  setLights(points: ReadonlyArray<LightPoint>): void {
    if (this.lights) this.removeObject(this.lights);

    const positions = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    const magnitudes = new Float32Array(points.length);
    points.forEach((point, i) => {
      positions.set(latLonToVec3(point.lat, point.lon, LIGHT_RADIUS), i * 3);
      const magnitude = Math.log10(Math.max(point.pop, 1000));
      magnitudes[i] = magnitude;
      sizes[i] = Math.min(2.6, 0.9 + Math.max(0, magnitude - 4.2) * 0.62);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new BufferAttribute(sizes, 1));
    geometry.setAttribute("aMagnitude", new BufferAttribute(magnitudes, 1));
    const material = new ShaderMaterial({
      vertexShader: lightsVertex,
      fragmentShader: lightsFragment,
      uniforms: {
        uSun: this.sunUniform,
        uScale: this.lightScale,
        uThreshold: this.lightThreshold,
      },
      transparent: true,
      depthWrite: false,
      // Hidden by facing away from the camera instead, so mountains near the limb can't swallow them.
      depthTest: false,
      blending: AdditiveBlending,
    });
    this.lights = new Points(geometry, material);
    this.lights.renderOrder = 2;
    this.scene.add(this.lights);
    this.dirty = true;
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (this.settleTimer !== null) clearTimeout(this.settleTimer);
    clearInterval(this.sunTimer);
    this.pixelRatioQuery?.removeEventListener("change", this.handlePixelRatioChange);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener("keydown", this.handleKeyDown);
    dom.removeEventListener("webglcontextrestored", this.handleContextRestored);
    document.removeEventListener("visibilitychange", this.handleVisibilityChange);
    this.rig.dispose();
    this.markers.dispose();
    for (const fade of this.fades) {
      if (fade.start === null) {
        fade.mesh.geometry.dispose();
        fade.mesh.material.dispose();
      }
    }
    this.fades = [];
    for (const object of [...this.scene.children]) this.removeObject(object as Mesh | Points);
    this.renderer.dispose();
    dom.remove();
  }

  /** Schedules one frame; frames keep coming only while something moves. */
  private requestRender = (): void => {
    this.dirty = true;
    if (!this.frame && !this.disposed) this.frame = requestAnimationFrame(this.tick);
  };

  private removeObject(object: Mesh | Points): void {
    this.scene.remove(object);
    object.geometry.dispose();
    (object.material as Material).dispose();
  }

  private applyPixelRatio(): void {
    const ratio = Math.min(window.devicePixelRatio || 1, this.detail === "low" ? 1.5 : 2);
    this.pixelRatioUniform.value = ratio;
    this.renderer.setPixelRatio(ratio);
  }

  /** Moving the window to another screen, or zooming the page, changes the pixel ratio. */
  private watchPixelRatio(): void {
    this.pixelRatioQuery?.removeEventListener("change", this.handlePixelRatioChange);
    this.pixelRatioQuery = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
    this.pixelRatioQuery.addEventListener("change", this.handlePixelRatioChange);
  }

  private handlePixelRatioChange = (): void => {
    this.applyPixelRatio();
    this.watchPixelRatio();
    this.resize();
  };

  private createEarthMesh(
    arrays: EarthArrays,
    opacity = { value: 1 },
  ): Mesh<BufferGeometry, ShaderMaterial> {
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(arrays.positions, 3));
    geometry.setAttribute("aColor", new BufferAttribute(arrays.colors, 4, true));
    const material = new ShaderMaterial({
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
      uniforms: { uSun: this.sunUniform, uOpacity: opacity },
    });
    return new Mesh(geometry, material);
  }

  /** Plain faceted ocean under the same lighting, so the land simply fades in once it's ready. */
  private addPlaceholder(): void {
    const sphere = new SphereGeometry(1, 48, 32).toNonIndexed();
    const positions = sphere.getAttribute("position").array as Float32Array<ArrayBuffer>;
    const colors = new Uint8Array((positions.length / 3) * 4);
    for (let i = 0; i < colors.length; i += 4) colors.set(PLACEHOLDER_COLOR, i);
    this.earth = this.createEarthMesh({ positions, colors });
    sphere.dispose();
    this.scene.add(this.earth);
  }

  /**
   * Fades a newly built globe in over the current one. While fading it draws
   * on top without depth testing; back faces are culled and the globe is
   * nearly convex, so it still looks right, and nothing pops when it takes over.
   */
  private showEarth(arrays: EarthArrays, final: boolean): void {
    if (this.disposed) return;
    const opacity = { value: 0 };
    const mesh = this.createEarthMesh(arrays, opacity);
    mesh.renderOrder = 1;
    mesh.material.transparent = true;
    mesh.material.depthTest = false;
    this.fades.push({ mesh, opacity, start: null, final, faces: arrays.positions.length / 9 });
    this.requestRender();
  }

  /** Advances fades; returns whether one is still running. */
  private advanceFades(now: number): boolean {
    const fade = this.fades[0];
    if (!fade) return false;
    if (fade.start === null) {
      fade.start = now;
      this.scene.add(fade.mesh);
    }
    const t = this.reducedMotion ? 1 : Math.min(1, (now - fade.start) / FADE_MS);
    fade.opacity.value = t * t * (3 - 2 * t);
    this.dirty = true;
    if (t < 1) return true;

    const { mesh, final, faces } = fade;
    mesh.material.transparent = false;
    mesh.material.depthTest = true;
    mesh.renderOrder = 0;
    if (this.earth) this.removeObject(this.earth);
    this.earth = mesh;
    this.fades.shift();
    // Tests and curious people can see what was built.
    this.container.dataset.faces = String(faces);
    if (final) this.container.dataset.globe = "ready";
    return this.fades.length > 0;
  }

  private addAtmosphere(): void {
    const material = new ShaderMaterial({
      vertexShader: atmosphereVertex,
      fragmentShader: atmosphereFragment,
      uniforms: { uSun: this.sunUniform },
      side: BackSide,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.scene.add(new Mesh(new SphereGeometry(1.1, 64, 48), material));
  }

  private addStars(): void {
    const count = 1400;
    const positions = new Float32Array(count * 3);
    const sizes = new Float32Array(count);
    // A fixed sequence, so the sky is the same on every visit.
    let seed = 42;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
    for (let i = 0; i < count; i++) {
      const y = random() * 2 - 1;
      const angle = random() * Math.PI * 2;
      const r = Math.sqrt(1 - y * y);
      positions.set([r * Math.cos(angle) * 30, y * 30, r * Math.sin(angle) * 30], i * 3);
      sizes[i] = 0.7 + random() * random() * 2;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new BufferAttribute(sizes, 1));
    const material = new ShaderMaterial({
      vertexShader: starsVertex,
      fragmentShader: starsFragment,
      uniforms: { uPixelRatio: this.pixelRatioUniform },
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(new Points(geometry, material));
  }

  private async loadEarth(): Promise<void> {
    this.container.dataset.globe = "loading";
    // The light globe first, then the full one, unless light is all this device gets.
    const tiers: DetailTier[] = this.detail === "low" ? ["low"] : ["low", this.detail];
    try {
      const file = await earthFile();
      if (this.disposed) return;
      try {
        await buildEarthInWorker({ file: file.slice(0), tiers }, (tier, arrays) =>
          this.showEarth(arrays, tier === tiers.at(-1)),
        );
      } catch (error) {
        if (this.disposed) return;
        console.warn("Building the globe in a worker failed; building it here instead", error);
        const { buildOnMainThread } = await import("./earthFallback");
        const tier = tiers.at(-1) ?? "low";
        this.showEarth(await buildOnMainThread(file, tier), true);
      }
    } catch (error) {
      // The plain ocean stays visible; time and weather are unaffected.
      console.warn("Could not load the globe's land data", error);
      this.container.dataset.globe = "failed";
    }
  }

  private resize(): void {
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    if (!width || !height) return;
    this.width = width;
    this.height = height;
    this.renderer.setSize(width, height);
    this.layout();
  }

  /** Where the globe sits, given the size and the insets. */
  private layout(): void {
    const { width, height } = this;
    if (width <= 1 || height <= 1) return;
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
      this.rig.jumpTo({
        lat: this.initial.lat,
        lon: this.initial.lon,
        distance: Math.min(this.initial.distance ?? Number.POSITIVE_INFINITY, this.rig.maxDistance),
      });
      // Arriving here isn't a move, so the first frame settles straight away.
      this.lastPosition.copy(this.camera.position);
      this.settleOnFirstFrame = true;
    }
    this.requestRender();
  }

  /** Eases the insets toward their target; returns whether still moving. */
  private advanceInsets(): boolean {
    const target = this.targetInsets;
    const current = this.insets;
    const ease = (a: number, b: number) => (Math.abs(b - a) < 0.5 ? b : a + (b - a) * 0.22);
    const next = {
      top: ease(current.top, target.top),
      right: ease(current.right, target.right),
      bottom: ease(current.bottom, target.bottom),
    };
    if (
      next.top === current.top &&
      next.right === current.right &&
      next.bottom === current.bottom
    ) {
      return false;
    }
    this.insets = next;
    this.layout();
    return true;
  }

  private refreshSun = (): void => {
    this.sunUniform.value.set(...sunDirection(new Date()));
    this.requestRender();
  };

  private tick = (now: number): void => {
    this.frame = 0;
    if (!this.positioned || this.disposed) return;
    const fading = this.advanceFades(now);
    const shifting = this.advanceInsets();
    const animating = this.rig.update(now) || fading || shifting;

    const moved = this.camera.position.distanceToSquared(this.lastPosition) > 1e-12;
    if (moved) {
      this.lastPosition.copy(this.camera.position);
      this.settled = false;
      this.dirty = true;
      if (this.settleTimer !== null) {
        clearTimeout(this.settleTimer);
        this.settleTimer = null;
      }
      this.callbacks.onMove(this.rig.view);
    }
    if (this.settleOnFirstFrame) {
      this.settleOnFirstFrame = false;
      if (!moved) this.settle();
    }
    if (!animating && !this.rig.interacting && !this.settled && this.settleTimer === null) {
      this.settleTimer = setTimeout(this.settle, SETTLE_MS);
    }

    if (this.dirty) {
      this.dirty = false;
      const altitude = this.camera.position.length() - 1;
      const ratio = this.pixelRatioUniform.value;
      this.lightScale.value = ratio * Math.min(1.6, 0.8 + 0.3 / Math.max(0.05, altitude));
      // Far away only the larger cities glow; towns join in closer up.
      this.lightThreshold.value = Math.min(5.6, Math.max(4.1, 4.1 + altitude * 0.75));
      this.markers.update(this.camera, this.markerLayout);
      this.renderer.render(this.scene, this.camera);
    }
    if (animating) this.requestRender();
  };

  private settle = (): void => {
    this.settleTimer = null;
    if (this.settled || this.rig.interacting || this.disposed) return;
    this.settled = true;
    this.callbacks.onSettle(this.rig.view);
  };

  /** Phones can drop the GPU context in the background; a restored canvas starts out blank. */
  private handleContextRestored = (): void => {
    this.requestRender();
  };

  private handleVisibilityChange = (): void => {
    // The sun kept moving while the page was hidden.
    if (document.visibilityState === "visible") this.refreshSun();
  };

  private handleTap = (x: number, y: number): void => {
    const city = this.markers.pick(x, y);
    if (city) {
      this.lastTapPoint = { lat: city.lat, lon: city.lon };
      this.callbacks.onTapCity(city);
      return;
    }
    const point = this.intersectGlobe(x, y);
    this.lastTapPoint = point;
    if (point) this.callbacks.onTapPoint(point.lat, point.lon);
  };

  /** The first tap already set off a flight there; the second zooms in on the way. */
  private handleDoubleTap = (x: number, y: number): void => {
    if (!this.lastTapPoint) {
      const point = this.intersectGlobe(x, y);
      if (!point) return;
      this.callbacks.onTapPoint(point.lat, point.lon);
    }
    this.rig.zoomBy(DOUBLE_TAP_ZOOM, performance.now());
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
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
    event.preventDefault();
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
