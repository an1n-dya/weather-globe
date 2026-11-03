import {
  AdditiveBlending,
  BackSide,
  BufferAttribute,
  BufferGeometry,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Points,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { latLonToVec3, vec3ToLatLon } from '../geo/coords';
import { sunDirection } from '../geo/sun';
import { dataUrl } from '../data';
import { fitDistance, FOV, GlobeCameraRig, type GlobeView } from './camera';
import { buildEarthArrays } from './earthMesh';
import {
  atmosphereFragment,
  atmosphereVertex,
  earthFragment,
  earthVertex,
  lightsFragment,
  lightsVertex,
  starsFragment,
  starsVertex,
} from './earth.shaders';
import { FREQUENCY_HIGH, FREQUENCY_LOW } from './icosphere';
import { CityMarkers, type MarkerCity } from './markers';

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

export interface LightPoint {
  lat: number;
  lon: number;
  pop: number;
}

const SETTLE_MS = 400;
const SUN_REFRESH_MS = 30_000;
const LIGHT_RADIUS = 1.036;

function prefersLowDetail(): boolean {
  const forced = new URLSearchParams(location.search).get('detail');
  if (forced) return forced === 'low';
  const nav = navigator as Navigator & { deviceMemory?: number };
  const coarse = matchMedia('(pointer: coarse)').matches;
  return coarse && (navigator.hardwareConcurrency <= 4 || (nav.deviceMemory ?? 8) <= 3);
}

export class GlobeScene {
  /** Screen position of the globe center, where the reticle belongs. */
  center = { x: 0, y: 0 };

  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly rig: GlobeCameraRig;
  private readonly sunUniform = { value: new Vector3(0, 0, 1) };
  private readonly lightScale = { value: 1 };
  private readonly raycaster = new Raycaster();
  private readonly lowDetail = prefersLowDetail();
  private readonly pixelRatio: number;
  private markers: CityMarkers | null = null;
  private frame = 0;
  private disposed = false;
  private dirty = true;
  private positioned = false;
  private lastPosition = new Vector3();
  private lastMoveAt = 0;
  private settled = false;
  private lastSunAt = -Infinity;
  private width = 1;
  private height = 1;
  private insets: Insets = { top: 0, right: 0, bottom: 0 };
  private pointerDown: { x: number; y: number; time: number } | null = null;
  private lights: Points | null = null;
  private placeholder: Mesh | null = null;
  private readonly resizeObserver: ResizeObserver;

  /** Throws if WebGL is unavailable, so callers can fall back to the panel alone. */
  constructor(
    private readonly container: HTMLElement,
    markerLayer: HTMLElement,
    cities: ReadonlyArray<MarkerCity>,
    private readonly initial: { lat: number; lon: number; distance?: number },
    insets: Insets,
    private readonly callbacks: GlobeCallbacks,
  ) {
    this.insets = insets;
    this.renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    this.pixelRatio = Math.min(window.devicePixelRatio || 1, this.lowDetail ? 1.5 : 2);
    this.renderer.setPixelRatio(this.pixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    container.append(this.renderer.domElement);

    this.camera = new PerspectiveCamera(FOV, 1, 0.02, 60);
    const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.rig = new GlobeCameraRig(this.camera, this.renderer.domElement, reducedMotion);
    this.markers = new CityMarkers(markerLayer, cities);

    this.addPlaceholder();
    this.addAtmosphere();
    this.addStars();
    void this.loadEarth();

    const dom = this.renderer.domElement;
    dom.addEventListener('pointerdown', this.handlePointerDown);
    dom.addEventListener('pointerup', this.handlePointerUp);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
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

  nudge(dLat: number, dLon: number): void {
    this.rig.nudge(dLat, dLon, performance.now());
  }

  zoomBy(factor: number): void {
    this.rig.zoomBy(factor, performance.now());
  }

  setInsets(insets: Insets): void {
    this.insets = insets;
    this.resize();
  }

  setCityWeather(...args: Parameters<CityMarkers['setWeather']>): void {
    this.markers?.setWeather(...args);
    this.dirty = true;
  }

  setLights(points: ReadonlyArray<LightPoint>): void {
    const positions = new Float32Array(points.length * 3);
    const sizes = new Float32Array(points.length);
    points.forEach((p, i) => {
      const [x, y, z] = latLonToVec3(p.lat, p.lon, LIGHT_RADIUS);
      positions.set([x, y, z], i * 3);
      sizes[i] = Math.min(4.2, 0.9 + Math.max(0, Math.log10(p.pop) - 4.2) * 1.2);
    });
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
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
    dom.removeEventListener('pointerdown', this.handlePointerDown);
    dom.removeEventListener('pointerup', this.handlePointerUp);
    this.rig.dispose();
    this.markers?.dispose();
    this.scene.traverse((object) => {
      const item = object as Mesh;
      item.geometry?.dispose();
      const material = item.material as ShaderMaterial | undefined;
      material?.dispose?.();
    });
    this.renderer.dispose();
    dom.remove();
  }

  private addPlaceholder(): void {
    this.placeholder = new Mesh(
      new SphereGeometry(1, 48, 32),
      new MeshBasicMaterial({ color: 0x24527a }),
    );
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
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('aSize', new BufferAttribute(sizes, 1));
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

      const { positions, normals, colors } = buildEarthArrays(frequency, mask);
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      geometry.setAttribute('normal', new BufferAttribute(normals, 3));
      geometry.setAttribute('aColor', new BufferAttribute(colors, 3, true));
      const material = new ShaderMaterial({
        vertexShader: earthVertex,
        fragmentShader: earthFragment,
        uniforms: { uSun: this.sunUniform },
      });
      this.scene.add(new Mesh(geometry, material));

      if (this.placeholder) {
        this.scene.remove(this.placeholder);
        this.placeholder.geometry.dispose();
        (this.placeholder.material as MeshBasicMaterial).dispose();
        this.placeholder = null;
      }
      this.dirty = true;
    } catch (error) {
      // The plain sphere stays visible; time and weather are unaffected.
      console.warn('Could not load land data', error);
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
    this.camera.updateProjectionMatrix();

    this.center = { x: width / 2 - offsetX, y: height / 2 - offsetY };
    this.container.style.setProperty('--globe-x', `${this.center.x}px`);
    this.container.style.setProperty('--globe-y', `${this.center.y}px`);

    const fit = fitDistance(Math.min(freeWidth, freeHeight), height);
    this.rig.setMaxDistance(fit * 1.04);

    // The fitted distance needs a real size, and a page opened in a hidden
    // window has none until it is first shown.
    if (!this.positioned) {
      this.positioned = true;
      this.rig.jumpTo({
        lat: this.initial.lat,
        lon: this.initial.lon,
        distance: Math.min(this.initial.distance ?? Infinity, this.rig.maxDistance),
      });
    }
    this.dirty = true;
  }

  private tick = (now: number): void => {
    this.frame = requestAnimationFrame(this.tick);
    if (!this.positioned) return;
    this.rig.update(now);

    if (now - this.lastSunAt > SUN_REFRESH_MS) {
      this.lastSunAt = now;
      const [x, y, z] = sunDirection(new Date());
      this.sunUniform.value.set(x, y, z);
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
      this.markers?.update(this.camera, this.width, this.height, this.center, this.insets);
      this.renderer.render(this.scene, this.camera);
    }
  };

  private handlePointerDown = (event: PointerEvent): void => {
    this.pointerDown = { x: event.clientX, y: event.clientY, time: performance.now() };
  };

  private handlePointerUp = (event: PointerEvent): void => {
    const start = this.pointerDown;
    this.pointerDown = null;
    if (!start) return;
    const travel = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (travel > 6 || performance.now() - start.time > 400) return;

    const rect = this.renderer.domElement.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;

    const city = this.markers?.pick(x, y);
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
