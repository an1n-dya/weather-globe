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
import { dataUrl } from "../data";
import { latLonToVec3, vec3ToLatLon } from "../geo/coords";
import { sunDirection } from "../geo/sun";
import { FOV, fitDistance, GlobeCameraRig, type GlobeView } from "./camera";
import { buildEarthArrays, type EarthArrays, OCEAN_MID } from "./earthMesh";
import type { EarthRequest } from "./earthWorker";
import { FREQUENCY_HIGH, FREQUENCY_LOW } from "./icosphere";
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

const SETTLE_MS = 400;
const SUN_REFRESH_MS = 30_000;
const LIGHT_RADIUS = 1.036;
const TAP_MAX_TRAVEL_PX = 6;
const TAP_MAX_MS = 400;
const ZOOM_IN_FACTOR = 0.72;
const ZOOM_OUT_FACTOR = 1.38;
const RETICLE_CLEARANCE_PX = 36;

function prefersLowDetail(): boolean {
  const forced = new URLSearchParams(location.search).get("detail");
  if (forced) return forced === "low";
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = matchMedia("(pointer: coarse)").matches;
  return coarse && (navigator.hardwareConcurrency <= 4 || (nav.deviceMemory ?? 8) <= 3);
}

function buildEarthInWorker(request: EarthRequest): Promise<EarthArrays> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./earthWorker.ts", import.meta.url), { type: "module" });
    worker.onmessage = ({ data }: MessageEvent<EarthArrays>) => {
      resolve(data);
      worker.terminate();
    };
    worker.onerror = (event) => {
      reject(new Error(event.message));
      worker.terminate();
    };
    worker.postMessage(request);
  });
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
  private readonly sunUniform = { value: new Vector3(0, 0, 1) };
  private readonly lightScale = { value: 1 };
  private readonly raycaster = new Raycaster();
  private readonly lowDetail = prefersLowDetail();
  private readonly pixelRatio: number;
  private readonly resizeObserver: ResizeObserver;
  private frame = 0;
  private disposed = false;
  private dirty = true;
  private positioned = false;
  private readonly lastPosition = new Vector3();
  private lastMoveAt = Number.NEGATIVE_INFINITY;
  private settled = false;
  private lastSunAt = Number.NEGATIVE_INFINITY;
  private width = 1;
  private height = 1;
  private markerLayout: MarkerLayout = { width: 1, height: 1, area: [0, 0, 1, 1], blocked: [] };
  private tapStart: { x: number; y: number; time: number; pointerId: number } | null = null;
  private lights: Points | null = null;
  private placeholder: Mesh | null = null;

  /** Throws if WebGL is unavailable, so callers can fall back to the panel alone. */
  constructor(options: GlobeSceneOptions) {
    this.container = options.container;
    this.initial = options.initial;
    this.insets = options.insets;
    this.callbacks = options.callbacks;
    this.obstacles = options.obstacles;

    this.renderer = new WebGLRenderer({ antialias: true, alpha: true });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.lowDetail ? 1.5 : 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);

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
    this.rig = new GlobeCameraRig(this.camera, dom, reducedMotion);
    this.markers = new CityMarkers(options.markerLayer, options.cities);

    this.addPlaceholder();
    this.addAtmosphere();
    this.addStars();
    void this.loadEarth();

    dom.addEventListener("pointerdown", this.handlePointerDown);
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
    this.rig.flyTo({ lat, lon, distance }, performance.now());
  }

  zoomBy(factor: number): void {
    this.rig.zoomBy(factor, performance.now());
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
    this.resize();
  }

  setCityWeather(contentFor: (city: MarkerCity) => MarkerContent | null): void {
    this.markers.setContent(contentFor);
    this.dirty = true;
  }

  setLights(points: ReadonlyArray<LightPoint>): void {
    if (this.lights) this.removeObject(this.lights);

    const positions = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    points.forEach((point, i) => {
      positions.set(latLonToVec3(point.lat, point.lon, LIGHT_RADIUS), i * 3);
      sizes[i] = Math.min(4.2, 0.9 + Math.max(0, Math.log10(point.pop) - 4.2) * 1.2);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(positions, 3));
    geometry.setAttribute("aSize", new BufferAttribute(sizes, 1));
    const material = new ShaderMaterial({
      vertexShader: lightsVertex,
      fragmentShader: lightsFragment,
      uniforms: { uSun: this.sunUniform, uScale: this.lightScale },
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
    });
    this.lights = new Points(geometry, material);
    this.scene.add(this.lights);
    this.dirty = true;
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.handlePointerDown);
    dom.removeEventListener("pointerup", this.handlePointerUp);
    dom.removeEventListener("pointercancel", this.handlePointerCancel);
    dom.removeEventListener("keydown", this.handleKeyDown);
    dom.removeEventListener("webglcontextrestored", this.handleContextRestored);
    this.rig.dispose();
    this.markers.dispose();
    for (const object of [...this.scene.children]) this.removeObject(object as Mesh | Points);
    this.renderer.dispose();
    dom.remove();
  }

  private removeObject(object: Mesh | Points): void {
    this.scene.remove(object);
    object.geometry.dispose();
    (object.material as Material).dispose();
  }

  private createEarthMaterial(): ShaderMaterial {
    return new ShaderMaterial({
      vertexShader: earthVertex,
      fragmentShader: earthFragment,
      uniforms: { uSun: this.sunUniform },
    });
  }

  /** Plain ocean under the same lighting, so the continents simply appear once they're ready. */
  private addPlaceholder(): void {
    const geometry = new SphereGeometry(1, 64, 48);
    const colors = new Float32Array(geometry.getAttribute("position").count * 3);
    for (let i = 0; i < colors.length; i += 3) colors.set(OCEAN_MID, i);
    geometry.setAttribute("aColor", new BufferAttribute(colors, 3));
    this.placeholder = new Mesh(geometry, this.createEarthMaterial());
    this.scene.add(this.placeholder);
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
      uniforms: { uPixelRatio: { value: this.pixelRatio } },
      transparent: true,
      depthWrite: false,
    });
    this.scene.add(new Points(geometry, material));
  }

  private async loadEarth(): Promise<void> {
    const frequency = this.lowDetail ? FREQUENCY_LOW : FREQUENCY_HIGH;
    try {
      const response = await fetch(dataUrl(`land-mask-${frequency}.bin`));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const mask = new Uint8Array(await response.arrayBuffer());
      if (this.disposed) return;

      const { positions, normals, colors } = await buildEarthInWorker({ frequency, mask }).catch(
        () => buildEarthArrays(frequency, mask),
      );
      if (this.disposed) return;

      const geometry = new BufferGeometry();
      geometry.setAttribute("position", new BufferAttribute(positions, 3));
      geometry.setAttribute("normal", new BufferAttribute(normals, 3));
      geometry.setAttribute("aColor", new BufferAttribute(colors, 3, true));
      this.scene.add(new Mesh(geometry, this.createEarthMaterial()));

      if (this.placeholder) {
        this.removeObject(this.placeholder);
        this.placeholder = null;
      }
      this.dirty = true;
    } catch (error) {
      // The plain sphere stays visible; time and weather are unaffected.
      console.warn("Could not load land data", error);
    }
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
      this.rig.jumpTo({
        lat: this.initial.lat,
        lon: this.initial.lon,
        distance: Math.min(this.initial.distance ?? Number.POSITIVE_INFINITY, this.rig.maxDistance),
      });
      // Arriving here isn't a move, so the first frame settles straight away.
      this.lastPosition.copy(this.camera.position);
    }
    this.dirty = true;
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.positioned) return;
    this.rig.update(now);

    if (now - this.lastSunAt > SUN_REFRESH_MS) {
      this.lastSunAt = now;
      this.sunUniform.value.set(...sunDirection(new Date()));
      this.dirty = true;
    }

    const moved = this.camera.position.distanceToSquared(this.lastPosition) > 1e-10;
    if (moved) {
      this.lastPosition.copy(this.camera.position);
      this.lastMoveAt = now;
      this.settled = false;
      this.dirty = true;
      this.callbacks.onMove(this.rig.view);
    } else if (!this.settled && now - this.lastMoveAt >= SETTLE_MS) {
      this.settled = true;
      this.callbacks.onSettle(this.rig.view);
    }

    // Drawing only on change keeps an idle globe from draining a battery.
    if (this.dirty) {
      this.dirty = false;
      const altitude = this.camera.position.length() - 1;
      this.lightScale.value = this.pixelRatio * Math.min(2.4, 0.75 + 0.55 / altitude);
      this.markers.update(this.camera, this.markerLayout);
      this.renderer.render(this.scene, this.camera);
    }
  };

  /** Phones can drop the GPU context in the background; a restored canvas starts out blank. */
  private handleContextRestored = (): void => {
    this.dirty = true;
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

  private handlePointerDown = (event: PointerEvent): void => {
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
      this.callbacks.onTapCity(city);
      return;
    }
    const point = this.intersectGlobe(x, y);
    if (point) this.callbacks.onTapPoint(point.lat, point.lon);
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
