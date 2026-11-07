import type { PerspectiveCamera } from "three";
import { clampViewLat, DEG, latLonToVec3, lonDelta, normalizeLon } from "../geo/coords";

export const FOV = 35;
export const MIN_DISTANCE = 1.12;
const TAN_HALF_FOV = Math.tan((FOV / 2) * DEG);

/** A fling slows by e (about 63%) every this many seconds, whatever the frame rate. */
const GLIDE_TIME_CONSTANT_S = 0.3;
/** A glide ends once it moves the globe slower than this on screen. */
const GLIDE_STOP_PX_PER_S = 8;
/** Zoom eases toward its target with this time constant. */
const ZOOM_TIME_CONSTANT_S = 0.085;
/** Only pointer movement this recent counts toward a fling's speed. */
const VELOCITY_WINDOW_MS = 90;
/** Holding still this long before letting go means no fling. */
const RELEASE_STILL_MS = 70;
const TAP_MAX_TRAVEL_PX = 6;
const TAP_MAX_MS = 400;
const DOUBLE_TAP_MS = 330;
const DOUBLE_TAP_PX = 36;

export interface GlobeView {
  lat: number;
  lon: number;
  distance: number;
}

interface Flight {
  from: GlobeView;
  dLon: number;
  to: GlobeView;
  start: number;
  duration: number;
}

export interface RigCallbacks {
  /** Something changed that needs a frame drawn. */
  wake(): void;
  /** A short press and release in place, in canvas pixels. */
  tap(x: number, y: number): void;
  /** A second tap soon after the first, near the same spot. */
  doubleTap(x: number, y: number): void;
}

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);

/**
 * Distance at which a unit sphere just fits a free area of `freeSize` pixels
 * on a canvas `height` pixels tall.
 */
export function fitDistance(freeSize: number, height: number, margin = 0.92): number {
  const tangent = (freeSize / height) * TAN_HALF_FOV * margin;
  return Math.sqrt(1 + 1 / (tangent * tangent));
}

/** How far the surface under the middle of the view turns per screen pixel, in degrees. */
export function degreesPerPixel(distance: number, viewportHeight: number): number {
  return (2 * TAN_HALF_FOV * Math.max(0, distance - 1)) / Math.max(1, viewportHeight) / DEG;
}

/** Exponential slow-down, so a glide lasts the same at 20 or 120 frames a second. */
export function decay(value: number, dtSeconds: number, timeConstantSeconds: number): number {
  return value * Math.exp(-dtSeconds / timeConstantSeconds);
}

/** factor < 1 moves closer. Altitude scales, so zooming is even at every height. */
export function scaledDistance(distance: number, factor: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, 1 + (distance - 1) * factor));
}

/**
 * The altitude factor for one wheel event. Trackpad pinches arrive as wheel
 * events with ctrlKey set and small deltas; mice send larger steps.
 */
export function wheelZoomFactor(deltaY: number, deltaMode: number, ctrlKey: boolean): number {
  const pixels = deltaY * (deltaMode === 1 ? 16 : deltaMode === 2 ? 400 : 1);
  const clamped = Math.max(-250, Math.min(250, pixels));
  return Math.exp(clamped * (ctrlKey ? 0.01 : 0.0022));
}

interface Sample {
  time: number;
  dLat: number;
  dLon: number;
}

/**
 * Turns pointer, wheel and keyboard input into a camera that orbits the globe
 * with north always up. Glides and zooms are timed in seconds rather than
 * frames, so a slow device settles as quickly as a fast one.
 */
export class GlobeCameraRig {
  private flight: Flight | null = null;
  private view_: GlobeView = { lat: 0, lon: 0, distance: 3 };
  private zoomTarget: number | null = null;
  private velocity = { lat: 0, lon: 0 };
  private lastUpdate: number | null = null;
  private running = false;
  private maxDistance_ = 4;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private samples: Sample[] = [];
  private drag: { x: number; y: number } | null = null;
  private pinch: { span: number; distance: number; x: number; y: number } | null = null;
  private press: { x: number; y: number; time: number; id: number } | null = null;
  private lastTap: { x: number; y: number; time: number } | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly dom: HTMLElement,
    private readonly reducedMotion: boolean,
    private readonly callbacks: RigCallbacks,
  ) {
    dom.addEventListener("pointerdown", this.handlePointerDown);
    dom.addEventListener("pointermove", this.handlePointerMove);
    dom.addEventListener("pointerup", this.handlePointerUp);
    dom.addEventListener("pointercancel", this.handlePointerCancel);
    dom.addEventListener("lostpointercapture", this.handlePointerCancel);
    dom.addEventListener("wheel", this.handleWheel, { passive: false });
    dom.addEventListener("contextmenu", this.handleContextMenu);
  }

  get view(): GlobeView {
    return { ...this.view_ };
  }

  /** A finger or button is down on the globe. */
  get interacting(): boolean {
    return this.pointers.size > 0;
  }

  get maxDistance(): number {
    return this.maxDistance_;
  }

  setMaxDistance(distance: number): void {
    this.maxDistance_ = Math.max(MIN_DISTANCE + 0.1, distance);
    if (this.view_.distance > this.maxDistance_) this.place({ ...this.view_ });
  }

  jumpTo(view: GlobeView): void {
    this.flight = null;
    this.zoomTarget = null;
    this.velocity = { lat: 0, lon: 0 };
    this.place(view);
  }

  flyTo(target: { lat: number; lon: number; distance?: number | undefined }, now: number): void {
    const from = this.view;
    const to: GlobeView = {
      lat: clampViewLat(target.lat),
      lon: normalizeLon(target.lon),
      distance: this.clampDistance(target.distance ?? this.zoomTarget ?? from.distance),
    };
    const dLon = lonDelta(from.lon, to.lon);
    const arc = Math.hypot(to.lat - from.lat, dLon);
    this.startFlight(from, to, 500 + Math.min(arc, 180) * 7, now);
  }

  /** Arrow keys: a step sized so it moves the same distance on screen at any zoom. */
  nudge(dLatScreens: number, dLonScreens: number, now: number): void {
    const from = this.view;
    const base = this.flight?.to ?? from;
    const step = this.degreesPerScreen(from.distance) * 0.12;
    const lonScale = 1 / Math.max(0.15, Math.cos(base.lat * DEG));
    const to: GlobeView = {
      lat: clampViewLat(base.lat + dLatScreens * step),
      lon: normalizeLon(base.lon + dLonScreens * step * lonScale),
      distance: this.zoomTarget ?? base.distance,
    };
    this.startFlight(from, to, 200, now);
  }

  /** factor < 1 moves closer. During a flight, changes where the flight ends. */
  zoomBy(factor: number, now: number): void {
    if (this.flight) {
      const { from, to, start, duration } = this.flight;
      const target = scaledDistance(to.distance, factor, MIN_DISTANCE, this.maxDistance_);
      const t = easeInOut(Math.min(1, Math.max(0, (now - start) / duration)));
      if (t < 0.9) {
        // Re-anchors the start so the distance carries on from where it is now, without a jump.
        const current = from.distance + (to.distance - from.distance) * t;
        const fromDistance = (current - target * t) / (1 - t);
        this.flight = {
          ...this.flight,
          from: { ...from, distance: fromDistance },
          to: { ...to, distance: target },
        };
        this.callbacks.wake();
      } else {
        this.startFlight(this.view, { ...to, distance: target }, 240, now);
      }
      return;
    }
    const base = this.zoomTarget ?? this.view_.distance;
    this.setZoomTarget(scaledDistance(base, factor, MIN_DISTANCE, this.maxDistance_));
  }

  /** Advances flights, glides and zooms. Returns whether anything is still moving. */
  update(now: number): boolean {
    // After a pause the first step is one frame long, not the whole pause.
    const dt =
      this.running && this.lastUpdate !== null
        ? Math.min(0.1, Math.max(0, (now - this.lastUpdate) / 1000))
        : 1 / 60;
    this.lastUpdate = now;
    const moving = this.advance(now, dt);
    this.running = moving;
    return moving;
  }

  private advance(now: number, dt: number): boolean {
    if (this.flight) {
      const { from, to, dLon, start, duration } = this.flight;
      const raw = Math.min(1, Math.max(0, (now - start) / duration));
      const t = easeInOut(raw);
      this.place({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + dLon * t,
        distance: from.distance + (to.distance - from.distance) * t,
      });
      if (raw >= 1) this.flight = null;
      return this.flight !== null;
    }

    let moving = false;
    if (this.zoomTarget !== null) {
      const target = this.zoomTarget;
      const next = target + decay(this.view_.distance - target, dt, ZOOM_TIME_CONSTANT_S);
      const done = Math.abs(next - target) < 1e-4 * (target - 1) || this.reducedMotion;
      this.place({ ...this.view_, distance: done ? target : next });
      if (done) this.zoomTarget = null;
      else moving = true;
    }

    if (!this.interacting && (this.velocity.lat !== 0 || this.velocity.lon !== 0)) {
      const view = this.view_;
      // The exact distance covered while slowing down over dt, so long frames
      // don't overshoot the way stepping at constant speed would.
      const travel = GLIDE_TIME_CONSTANT_S * (1 - Math.exp(-dt / GLIDE_TIME_CONSTANT_S));
      this.place({
        lat: view.lat + this.velocity.lat * travel,
        lon: view.lon + this.velocity.lon * travel,
        distance: view.distance,
      });
      // Running into the pole ends the north-south part of a glide.
      if (Math.abs(this.view_.lat) >= clampViewLat(90)) this.velocity.lat = 0;
      this.velocity.lat = decay(this.velocity.lat, dt, GLIDE_TIME_CONSTANT_S);
      this.velocity.lon = decay(this.velocity.lon, dt, GLIDE_TIME_CONSTANT_S);
      const perPixel = degreesPerPixel(this.view_.distance, this.viewportHeight);
      const lonOnScreen = this.velocity.lon * Math.cos(this.view_.lat * DEG);
      if (Math.hypot(this.velocity.lat, lonOnScreen) / perPixel < GLIDE_STOP_PX_PER_S) {
        this.velocity = { lat: 0, lon: 0 };
      } else {
        moving = true;
      }
    }
    return moving;
  }

  dispose(): void {
    const dom = this.dom;
    dom.removeEventListener("pointerdown", this.handlePointerDown);
    dom.removeEventListener("pointermove", this.handlePointerMove);
    dom.removeEventListener("pointerup", this.handlePointerUp);
    dom.removeEventListener("pointercancel", this.handlePointerCancel);
    dom.removeEventListener("lostpointercapture", this.handlePointerCancel);
    dom.removeEventListener("wheel", this.handleWheel);
    dom.removeEventListener("contextmenu", this.handleContextMenu);
  }

  private get viewportHeight(): number {
    return this.dom.clientHeight || 1;
  }

  private degreesPerScreen(distance: number): number {
    return degreesPerPixel(distance, 1);
  }

  private startFlight(from: GlobeView, to: GlobeView, duration: number, now: number): void {
    this.velocity = { lat: 0, lon: 0 };
    this.zoomTarget = null;
    if (this.reducedMotion) {
      this.jumpTo(to);
      this.callbacks.wake();
      return;
    }
    this.flight = { from, to, dLon: lonDelta(from.lon, to.lon), start: now, duration };
    this.callbacks.wake();
  }

  private setZoomTarget(distance: number): void {
    this.flight = null;
    if (this.reducedMotion) {
      this.zoomTarget = null;
      this.place({ ...this.view_, distance });
    } else {
      this.zoomTarget = distance;
    }
    this.callbacks.wake();
  }

  private clampDistance(distance: number): number {
    return Math.max(MIN_DISTANCE, Math.min(this.maxDistance_, distance));
  }

  private place({ lat, lon, distance }: GlobeView): void {
    this.view_ = {
      lat: clampViewLat(lat),
      lon: normalizeLon(lon),
      distance: this.clampDistance(distance),
    };
    const [x, y, z] = latLonToVec3(this.view_.lat, this.view_.lon, this.view_.distance);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);
  }

  /** Turns the globe so the surface follows the pointer. */
  private rotateByPixels(dx: number, dy: number, time: number): void {
    const perPixel = degreesPerPixel(this.view_.distance, this.viewportHeight);
    const lonScale = 1 / Math.max(0.2, Math.cos(this.view_.lat * DEG));
    const dLat = dy * perPixel;
    const dLon = -dx * perPixel * lonScale;
    this.place({ ...this.view_, lat: this.view_.lat + dLat, lon: this.view_.lon + dLon });
    this.samples.push({ time, dLat, dLon });
    this.samples = this.samples.filter((s) => time - s.time <= VELOCITY_WINDOW_MS);
  }

  private releaseVelocity(time: number): { lat: number; lon: number } {
    const recent = this.samples.filter((s) => time - s.time <= VELOCITY_WINDOW_MS);
    const first = recent[0];
    const last = recent.at(-1);
    if (!first || !last || recent.length < 2 || time - last.time > RELEASE_STILL_MS) {
      return { lat: 0, lon: 0 };
    }
    if (this.reducedMotion) return { lat: 0, lon: 0 };
    // The first sample's movement happened before the window began.
    const span = Math.max(16, last.time - first.time) / 1000;
    let dLat = 0;
    let dLon = 0;
    for (const s of recent.slice(1)) {
      dLat += s.dLat;
      dLon += s.dLon;
    }
    return { lat: dLat / span, lon: dLon / span };
  }

  private local(event: PointerEvent): { x: number; y: number } {
    const rect = this.dom.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    if (!a || !b) return;
    this.pinch = {
      span: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
      distance: this.zoomTarget ?? this.view_.distance,
      x: (a.x + b.x) / 2,
      y: (a.y + b.y) / 2,
    };
    this.drag = null;
    this.press = null;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    // Other mouse buttons neither turn the globe nor count as taps.
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = this.local(event);
    try {
      this.dom.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events can't be captured; the drag still works over the canvas.
    }
    this.pointers.set(event.pointerId, point);
    this.flight = null;
    this.velocity = { lat: 0, lon: 0 };
    this.samples = [];
    if (this.pointers.size === 1) {
      this.drag = point;
      this.press = { ...point, time: event.timeStamp, id: event.pointerId };
    } else {
      this.beginPinch();
    }
    this.callbacks.wake();
  };

  private handlePointerMove = (event: PointerEvent): void => {
    const known = this.pointers.get(event.pointerId);
    if (!known) return;
    const point = this.local(event);
    this.pointers.set(event.pointerId, point);

    if (
      this.press &&
      Math.hypot(point.x - this.press.x, point.y - this.press.y) > TAP_MAX_TRAVEL_PX
    ) {
      this.press = null;
    }

    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      if (!a || !b) return;
      const span = Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
      const x = (a.x + b.x) / 2;
      const y = (a.y + b.y) / 2;
      const distance = scaledDistance(
        this.pinch.distance,
        this.pinch.span / span,
        MIN_DISTANCE,
        this.maxDistance_,
      );
      this.zoomTarget = null;
      this.place({ ...this.view_, distance });
      this.rotateByPixels(x - this.pinch.x, y - this.pinch.y, event.timeStamp);
      this.pinch = { ...this.pinch, x, y };
    } else if (this.drag) {
      this.rotateByPixels(point.x - this.drag.x, point.y - this.drag.y, event.timeStamp);
      this.drag = point;
    }
    this.callbacks.wake();
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (!this.pointers.has(event.pointerId)) return;
    const point = this.local(event);
    this.pointers.delete(event.pointerId);

    if (this.pointers.size === 0) {
      const press = this.press;
      const isTap =
        press !== null &&
        press.id === event.pointerId &&
        event.timeStamp - press.time <= TAP_MAX_MS &&
        Math.hypot(point.x - press.x, point.y - press.y) <= TAP_MAX_TRAVEL_PX;
      if (isTap) {
        const last = this.lastTap;
        const isDouble =
          last !== null &&
          event.timeStamp - last.time <= DOUBLE_TAP_MS &&
          Math.hypot(point.x - last.x, point.y - last.y) <= DOUBLE_TAP_PX;
        if (isDouble) {
          this.lastTap = null;
          this.callbacks.doubleTap(point.x, point.y);
        } else {
          this.lastTap = { ...point, time: event.timeStamp };
          this.callbacks.tap(point.x, point.y);
        }
      } else if (!this.pinch) {
        this.velocity = this.releaseVelocity(event.timeStamp);
      }
      this.drag = null;
      this.pinch = null;
      this.press = null;
      this.samples = [];
    } else if (this.pointers.size === 1) {
      // One finger of a pinch lifted: the other carries on turning the globe.
      const [remaining] = [...this.pointers.values()];
      this.pinch = null;
      this.drag = remaining ?? null;
      this.samples = [];
    } else {
      this.beginPinch();
    }
    this.callbacks.wake();
  };

  private handlePointerCancel = (event: PointerEvent): void => {
    // Also runs on lostpointercapture, which follows every pointerup: by then there's nothing left.
    if (!this.pointers.delete(event.pointerId)) return;
    if (this.pointers.size === 0) {
      this.drag = null;
      this.pinch = null;
      this.press = null;
      this.samples = [];
    }
    this.callbacks.wake();
  };

  private handleWheel = (event: WheelEvent): void => {
    event.preventDefault();
    this.zoomBy(wheelZoomFactor(event.deltaY, event.deltaMode, event.ctrlKey), performance.now());
  };

  private handleContextMenu = (event: Event): void => {
    // A long press on a touch screen would otherwise open a menu mid-drag.
    if (this.pointers.size > 0) event.preventDefault();
  };
}
