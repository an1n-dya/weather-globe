import { type PerspectiveCamera, Vector3 } from "three";
import { latLonToVec3 } from "../geo/coords";

export interface MarkerCity {
  name: string;
  country: string;
  lat: number;
  lon: number;
  pop: number;
}

export interface MarkerContent {
  iconSrc: string;
  temperature: string;
}

/** left, top, right, bottom, in pixels. */
type Box = readonly [number, number, number, number];

export interface MarkerLayout {
  width: number;
  height: number;
  /** The part of the screen left free by the panel or sheet. */
  area: Box;
  /** Places within that area that markers should stay clear of. */
  blocked: ReadonlyArray<Box>;
}

interface Marker {
  city: MarkerCity;
  position: Vector3;
  element: HTMLElement;
  icon: HTMLImageElement;
  temp: HTMLElement;
  shown: boolean;
  x: number;
  y: number;
}

/** How much room badges need around them, and how many may show, at a camera distance. */
export function markerDensity(distance: number): { gap: number; limit: number } {
  const gap = Math.round(Math.max(4, Math.min(30, (distance - 1.3) * 16)));
  const limit = distance > 2.6 ? 16 : distance > 1.9 ? 26 : 60;
  return { gap, limit };
}

/** Below this camera distance, markers also show the city name. */
const NAMED_DISTANCE = 2.3;
const TAP_RADIUS_PX = 26;

function createElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  return element;
}

/**
 * City markers are DOM elements positioned over the canvas, which keeps text
 * crisp. They never take pointer events, so a drag that starts on one still
 * turns the globe; taps use `pick` instead.
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
        const element = createElement("div", "city-marker");
        const body = createElement("div", "city-marker-body");
        const icon = createElement("img", "city-marker-icon");
        icon.alt = "";
        const temp = createElement("span", "city-marker-temp");
        const name = createElement("span", "city-marker-name");
        name.textContent = city.name;
        body.append(icon, temp, name);
        element.append(body, createElement("div", "city-marker-pin"));
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

  setContent(contentFor: (city: MarkerCity) => MarkerContent | null): void {
    for (const marker of this.markers) {
      const content = contentFor(marker.city);
      marker.element.classList.toggle("has-weather", content !== null);
      marker.temp.textContent = content?.temperature ?? "";
      // Only when changed, as this runs every minute for every marker.
      if (content && marker.icon.getAttribute("src") !== content.iconSrc) {
        marker.icon.src = content.iconSrc;
      }
    }
  }

  update(camera: PerspectiveCamera, { width, height, area, blocked }: MarkerLayout): void {
    const distance = camera.position.length();
    const named = distance < NAMED_DISTANCE;
    this.layer.classList.toggle("is-named", named);
    const halfW = named ? 52 : 32;
    const boxH = named ? 46 : 34;
    // Zoomed out, fewer badges with more room around each; closer in, more of them.
    const { gap, limit } = markerDensity(distance);

    const taken: Box[] = [...blocked];
    // Keep clear of the limb, where badges would crowd and tilt away.
    const horizon = 1 / distance + 0.12;
    const cameraDir = camera.position.clone().normalize();
    let shown = 0;

    for (const marker of this.markers) {
      let show = shown < limit && marker.position.dot(cameraDir) > horizon;
      if (show) {
        const projected = this.scratch.copy(marker.position).project(camera);
        const x = ((projected.x + 1) / 2) * width;
        const y = ((1 - projected.y) / 2) * height;
        // Follows the globe even when hidden, so a marker fading out doesn't lag behind.
        marker.x = x;
        marker.y = y;
        marker.element.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0)`;

        const left = x - halfW;
        const right = x + halfW;
        const top = y - boxH - 6;
        const bottom = y;
        // Only where it fits whole, clear of everything else.
        show =
          left >= area[0] &&
          top >= area[1] &&
          right <= area[2] &&
          bottom <= area[3] &&
          !taken.some(
            (t) =>
              left - gap < t[2] && right + gap > t[0] && top - gap < t[3] && bottom + gap > t[1],
          );
        if (show) {
          taken.push([left, top, right, bottom]);
          shown++;
        }
      }
      if (show !== marker.shown) {
        marker.shown = show;
        marker.element.classList.toggle("is-shown", show);
      }
    }
  }

  /** The visible marker within reach of a tap, if any. */
  pick(x: number, y: number): MarkerCity | null {
    let best: MarkerCity | null = null;
    let bestDistance = TAP_RADIUS_PX;
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
