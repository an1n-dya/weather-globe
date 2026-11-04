import type { WeatherIcon } from "../weather/wmo";

/** Shapes on a 32-unit square, shared by the static icons and the animated one. */
export const ICON_COLORS = {
  sun: "#ffc94d",
  moon: "#c9d6f2",
  cloud: "#e8eef7",
  cloudDark: "#a9b6c9",
  rain: "#6db8f2",
  snow: "#dff3ff",
  bolt: "#ffc94d",
} as const;

export const CLOUD_PATH =
  "M9.5 24.5h14a5.5 5.5 0 0 0 .9-10.9 7.5 7.5 0 0 0-14.3-1.4A6.2 6.2 0 0 0 9.5 24.5z";
export const MOON_PATH = "M10.5 0.6A8 8 0 1 0 15.4 11 6.6 6.6 0 0 1 10.5 0.6z";
export const BOLT_PATH = "M17.5 19l-5 7h3.6l-1.6 5 6-7.5h-3.8l2.3-4.5z";
export const FOG_PATHS = ["M7 25h18", "M10 29h12"];
export const RAIN_XS = { drizzle: [13, 20], rain: [10, 16, 22] } as const;
export const FLAKES = [
  [10, 27],
  [16, 29],
  [22, 27],
] as const;

/** Where the shapes of each icon sit. */
export interface IconLayout {
  sun: { cx: number; cy: number; r: number } | null;
  moon: { cx: number; cy: number; r: number } | null;
  cloud: { color: string; dy: number } | null;
  drops: readonly number[];
  flakes: boolean;
  bolt: boolean;
  fog: boolean;
}

export function iconLayout(icon: WeatherIcon, isDay: boolean): IconLayout {
  const none: IconLayout = {
    sun: null,
    moon: null,
    cloud: null,
    drops: [],
    flakes: false,
    bolt: false,
    fog: false,
  };
  const c = ICON_COLORS;
  switch (icon) {
    case "clear":
      return isDay
        ? { ...none, sun: { cx: 16, cy: 16, r: 6.5 } }
        : { ...none, moon: { cx: 16, cy: 16, r: 8 } };
    case "partly":
      return {
        ...none,
        sun: isDay ? { cx: 22, cy: 10, r: 4.5 } : null,
        moon: isDay ? null : { cx: 23, cy: 9, r: 6 },
        cloud: { color: isDay ? c.cloud : c.cloudDark, dy: 2 },
      };
    case "cloudy":
      return { ...none, cloud: { color: c.cloudDark, dy: 1 } };
    case "fog":
      return { ...none, cloud: { color: c.cloudDark, dy: -3 }, fog: true };
    case "drizzle":
      return { ...none, cloud: { color: c.cloud, dy: -3 }, drops: RAIN_XS.drizzle };
    case "rain":
      return { ...none, cloud: { color: c.cloudDark, dy: -3 }, drops: RAIN_XS.rain };
    case "snow":
      return { ...none, cloud: { color: c.cloud, dy: -3 }, flakes: true };
    case "thunder":
      return { ...none, cloud: { color: c.cloudDark, dy: -3 }, bolt: true };
  }
}

/** The eight short rays around a sun, as line segments. */
export function sunRays(
  cx: number,
  cy: number,
  r: number,
): Array<[number, number, number, number]> {
  return Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    return [
      cx + Math.cos(a) * (r + 2.2),
      cy + Math.sin(a) * (r + 2.2),
      cx + Math.cos(a) * (r + 5),
      cy + Math.sin(a) * (r + 5),
    ];
  });
}

const f = (value: number) => value.toFixed(1);

function drawing(icon: WeatherIcon, isDay: boolean): string {
  const layout = iconLayout(icon, isDay);
  const c = ICON_COLORS;
  let svg = "";
  if (layout.sun) {
    const { cx, cy, r } = layout.sun;
    const rays = sunRays(cx, cy, r)
      .map(([x1, y1, x2, y2]) => `<path d="M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}"/>`)
      .join("");
    svg += `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${c.sun}"/><g stroke="${c.sun}" stroke-width="2" stroke-linecap="round">${rays}</g>`;
  }
  if (layout.moon) {
    const { cx, cy, r } = layout.moon;
    svg += `<path transform="translate(${cx - r} ${cy - r}) scale(${r / 8})" d="${MOON_PATH}" fill="${c.moon}"/>`;
  }
  if (layout.cloud) {
    svg += `<path transform="translate(0 ${layout.cloud.dy})" d="${CLOUD_PATH}" fill="${layout.cloud.color}"/>`;
  }
  for (const x of layout.drops) {
    svg += `<path d="M${x} 24.5l-1.6 4.5" stroke="${c.rain}" stroke-width="2.2" stroke-linecap="round"/>`;
  }
  if (layout.flakes) {
    svg += FLAKES.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.7" fill="${c.snow}"/>`).join(
      "",
    );
  }
  if (layout.bolt) svg += `<path d="${BOLT_PATH}" fill="${c.bolt}"/>`;
  if (layout.fog) {
    svg += `<g stroke="${c.cloud}" stroke-width="2.2" stroke-linecap="round">${FOG_PATHS.map((d) => `<path d="${d}"/>`).join("")}</g>`;
  }
  return svg;
}

const sources = new Map<string, string>();

/** An image source for a weather icon, for use in an `<img>` element. */
export function iconSrc(icon: WeatherIcon, isDay: boolean): string {
  const key = `${icon}-${isDay}`;
  let source = sources.get(key);
  if (!source) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">${drawing(icon, isDay)}</svg>`;
    source = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    sources.set(key, source);
  }
  return source;
}
