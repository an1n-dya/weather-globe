import type { PerspectiveCamera } from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { lonDelta, latLonToVec3, vec3ToLatLon } from '../geo/coords';

export const FOV = 35;
export const MIN_DISTANCE = 1.14;
const MAX_LAT = 89;
const TAN_HALF_FOV = Math.tan((FOV / 2) * (Math.PI / 180));

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

const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
const clampLat = (lat: number) => Math.max(-MAX_LAT, Math.min(MAX_LAT, lat));

/**
 * Distance at which a unit sphere just fits a free area of `freeSize` pixels
 * on a canvas `height` pixels tall.
 */
export function fitDistance(freeSize: number, height: number, margin = 0.92): number {
  const tangent = (freeSize / height) * TAN_HALF_FOV * margin;
  return Math.sqrt(1 + 1 / (tangent * tangent));
}

/** Keeps north up: rotation is latitude and longitude, never roll. */
export class GlobeCameraRig {
  readonly controls: OrbitControls;
  private flight: Flight | null = null;

  constructor(
    private readonly camera: PerspectiveCamera,
    dom: HTMLElement,
    private readonly reducedMotion: boolean,
  ) {
    const controls = new OrbitControls(camera, dom);
    controls.enablePan = false;
    controls.enableDamping = !reducedMotion;
    controls.dampingFactor = 0.08;
    controls.minDistance = MIN_DISTANCE;
    controls.minPolarAngle = ((90 - MAX_LAT) * Math.PI) / 180;
    controls.maxPolarAngle = ((90 + MAX_LAT) * Math.PI) / 180;
    controls.addEventListener('start', () => {
      this.flight = null;
    });
    this.controls = controls;
  }

  get view(): GlobeView {
    const { x, y, z } = this.camera.position;
    const { lat, lon } = vec3ToLatLon(x, y, z);
    return { lat, lon, distance: this.camera.position.length() };
  }

  setMaxDistance(distance: number): void {
    this.controls.maxDistance = distance;
  }

  get maxDistance(): number {
    return this.controls.maxDistance;
  }

  jumpTo(view: GlobeView): void {
    this.flight = null;
    this.place(view);
  }

  flyTo(target: Partial<GlobeView> & { lat: number; lon: number }, now: number): void {
    const from = this.view;
    const to: GlobeView = {
      lat: clampLat(target.lat),
      lon: target.lon,
      distance: this.clampDistance(target.distance ?? from.distance),
    };
    if (this.reducedMotion) {
      this.jumpTo(to);
      return;
    }
    const dLon = lonDelta(from.lon, to.lon);
    const arc = Math.hypot(to.lat - from.lat, dLon);
    this.flight = {
      from,
      to,
      dLon,
      start: now,
      duration: 500 + Math.min(arc, 180) * 7,
    };
  }

  /** Arrow keys: a step sized so it moves the same distance on screen at any zoom. */
  nudge(dLatScreens: number, dLonScreens: number, now: number): void {
    const { lat, lon, distance } = this.view;
    const step = this.degreesPerScreen(distance) * 0.12;
    const lonScale = 1 / Math.max(0.15, Math.cos((lat * Math.PI) / 180));
    this.startShortMove(
      {
        lat: clampLat(lat + dLatScreens * step),
        lon: lon + dLonScreens * step * lonScale,
        distance,
      },
      now,
    );
  }

  /** factor < 1 moves closer. Altitude scales, so zooming is even at every height. */
  zoomBy(factor: number, now: number): void {
    const { lat, lon, distance } = this.flight?.to ?? this.view;
    this.startShortMove({ lat, lon, distance: 1 + (distance - 1) * factor }, now);
  }

  /** Advances any flight and the orbit controls. */
  update(now: number): void {
    const distance = this.camera.position.length();
    const altitude = distance - 1;

    // One drag across the screen tracks the surface under the pointer.
    this.controls.rotateSpeed = ((2 * TAN_HALF_FOV * altitude) / (2 * Math.PI)) * 1.15;

    // OrbitControls scales the distance from the center; aim for a steady
    // change in altitude per wheel tick instead.
    const nextDistance = 1 + altitude * 0.86;
    this.controls.zoomSpeed = Math.log(nextDistance / distance) / Math.log(0.95);

    if (this.flight) {
      const { from, to, dLon, start, duration } = this.flight;
      const raw = Math.min(1, (now - start) / duration);
      const t = easeInOut(raw);
      this.place({
        lat: from.lat + (to.lat - from.lat) * t,
        lon: from.lon + dLon * t,
        distance: from.distance + (to.distance - from.distance) * t,
      });
      if (raw >= 1) this.flight = null;
    }

    this.controls.update();
  }

  dispose(): void {
    this.controls.dispose();
  }

  private degreesPerScreen(distance: number): number {
    return (2 * TAN_HALF_FOV * (distance - 1) * 180) / Math.PI;
  }

  private startShortMove(to: GlobeView, now: number): void {
    const clamped = { ...to, distance: this.clampDistance(to.distance) };
    if (this.reducedMotion) {
      this.jumpTo(clamped);
      return;
    }
    const from = this.view;
    this.flight = { from, to: clamped, dLon: lonDelta(from.lon, clamped.lon), start: now, duration: 180 };
  }

  private clampDistance(distance: number): number {
    return Math.max(MIN_DISTANCE, Math.min(this.controls.maxDistance, distance));
  }

  private place({ lat, lon, distance }: GlobeView): void {
    const [x, y, z] = latLonToVec3(lat, lon, distance);
    this.camera.position.set(x, y, z);
    this.camera.lookAt(0, 0, 0);
  }
}
