import { Vector3, type PerspectiveCamera } from 'three';
import { latLonToVec3 } from '../geo/coords';
import { formatTemperature, type TempUnit } from '../ui/format';
import { iconSvg } from '../ui/icons';
import { describeWeatherCode } from '../weather/wmo';
import type { CityCurrent } from '../weather/provider';

export interface MarkerCity {
  name: string;
  country: string;
  lat: number;
  lon: number;
  pop: number;
}

interface Marker {
  city: MarkerCity;
  position: Vector3;
  element: HTMLElement;
  icon: HTMLElement;
  temp: HTMLElement;
  shown: boolean;
  x: number;
  y: number;
}

/** Below this camera distance, markers also show the city name. */
const NAMED_DISTANCE = 2.3;

/**
 * City markers are DOM elements positioned over the canvas: text stays crisp
 * and icons are shared with the panel. They never take pointer events, so a
 * drag that starts on one still turns the globe; taps use `pick` instead.
 */
export class CityMarkers {
  private readonly markers: Marker[];
  private readonly scratch = new Vector3();

  constructor(
    private readonly layer: HTMLElement,
    cities: ReadonlyArray<MarkerCity>,
  ) {
    // Sorted by population so larger cities win when markers collide.
    this.markers = [...cities]
      .sort((a, b) => b.pop - a.pop)
      .map((city) => {
        const element = document.createElement('div');
        element.className = 'city-marker';
        const body = document.createElement('div');
        body.className = 'city-marker-body';
        const icon = document.createElement('span');
        icon.className = 'city-marker-icon';
        const temp = document.createElement('span');
        temp.className = 'city-marker-temp';
        const name = document.createElement('span');
        name.className = 'city-marker-name';
        name.textContent = city.name;
        body.append(icon, temp, name);
        const pin = document.createElement('div');
        pin.className = 'city-marker-pin';
        element.append(body, pin);
        layer.append(element);
        const [x, y, z] = latLonToVec3(city.lat, city.lon);
        return {
          city,
          element,
          icon,
          temp,
          position: new Vector3(x, y, z),
          shown: false,
          x: 0,
          y: 0,
        };
      });
  }

  setWeather(lookup: (city: MarkerCity) => CityCurrent | null, unit: TempUnit): void {
    for (const marker of this.markers) {
      const current = lookup(marker.city);
      if (!current) {
        marker.element.classList.remove('has-weather');
        marker.icon.innerHTML = '';
        marker.temp.textContent = '';
        continue;
      }
      const condition = describeWeatherCode(current.code);
      marker.element.classList.add('has-weather');
      marker.icon.innerHTML = iconSvg(condition.icon, current.isDay);
      marker.temp.textContent = formatTemperature(current.temp, unit);
    }
  }

  update(
    camera: PerspectiveCamera,
    width: number,
    height: number,
    center: { x: number; y: number },
    insets: { top: number; right: number; bottom: number },
  ): void {
    const distance = camera.position.length();
    const named = distance < NAMED_DISTANCE;
    this.layer.classList.toggle('is-named', named);
    const halfW = named ? 52 : 30;
    const boxH = named ? 46 : 34;

    // The reticle area is reserved so it stays readable.
    const taken: Array<[number, number, number, number]> = [
      [center.x - 36, center.y - 36, center.x + 36, center.y + 36],
    ];
    const horizon = 1 / distance + 0.04;
    const cameraDir = camera.position.clone().normalize();

    for (const marker of this.markers) {
      let show = marker.position.dot(cameraDir) > horizon;
      if (show) {
        const projected = this.scratch.copy(marker.position).project(camera);
        const x = ((projected.x + 1) / 2) * width;
        const y = ((1 - projected.y) / 2) * height;
        const box: [number, number, number, number] = [x - halfW, y - boxH - 6, x + halfW, y];
        // Only where it fits whole, clear of the panel and the screen edges.
        show =
          box[0] >= 0 &&
          box[2] <= width - insets.right &&
          box[1] >= insets.top &&
          box[3] <= height - insets.bottom &&
          !taken.some((t) => box[0] < t[2] && box[2] > t[0] && box[1] < t[3] && box[3] > t[1]);
        if (show) {
          taken.push(box);
          marker.x = x;
          marker.y = y;
          marker.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;
        }
      }
      if (show !== marker.shown) {
        marker.shown = show;
        marker.element.classList.toggle('is-shown', show);
      }
    }
  }

  /** The visible marker within reach of a tap, if any. */
  pick(x: number, y: number): MarkerCity | null {
    let best: MarkerCity | null = null;
    let bestDistance = 26;
    for (const marker of this.markers) {
      if (!marker.shown) continue;
      // Measured to the middle of the marker, which sits above its anchor.
      const d = Math.hypot(marker.x - x, marker.y - 20 - y);
      if (d < bestDistance) {
        best = marker.city;
        bestDistance = d;
      }
    }
    return best;
  }

  dispose(): void {
    for (const marker of this.markers) marker.element.remove();
  }
}
