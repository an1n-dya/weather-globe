import type { WeatherIcon } from "../weather/wmo";

const SUN = "#ffc94d";
const MOON = "#c9d6f2";
const CLOUD = "#e8eef7";
const CLOUD_DARK = "#a9b6c9";
const RAIN = "#6db8f2";
const SNOW = "#dff3ff";
const BOLT = "#ffc94d";

function sun(cx: number, cy: number, r: number): string {
  const rays = Array.from({ length: 8 }, (_, i) => {
    const a = (i * Math.PI) / 4;
    const x1 = cx + Math.cos(a) * (r + 2.2);
    const y1 = cy + Math.sin(a) * (r + 2.2);
    const x2 = cx + Math.cos(a) * (r + 5);
    const y2 = cy + Math.sin(a) * (r + 5);
    return `<path d="M${x1.toFixed(1)} ${y1.toFixed(1)}L${x2.toFixed(1)} ${y2.toFixed(1)}"/>`;
  }).join("");
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${SUN}"/><g stroke="${SUN}" stroke-width="2" stroke-linecap="round">${rays}</g>`;
}

function moon(cx: number, cy: number, r: number): string {
  return `<path transform="translate(${cx - r} ${cy - r}) scale(${r / 8})" d="M10.5 0.6A8 8 0 1 0 15.4 11 6.6 6.6 0 0 1 10.5 0.6z" fill="${MOON}"/>`;
}

function cloud(color: string, dy = 0): string {
  return `<path transform="translate(0 ${dy})" d="M9.5 24.5h14a5.5 5.5 0 0 0 .9-10.9 7.5 7.5 0 0 0-14.3-1.4A6.2 6.2 0 0 0 9.5 24.5z" fill="${color}"/>`;
}

function drops(color: string, xs: number[]): string {
  return xs
    .map(
      (x) =>
        `<path d="M${x} 24.5l-1.6 4.5" stroke="${color}" stroke-width="2.2" stroke-linecap="round"/>`,
    )
    .join("");
}

function flakes(): string {
  return [10, 16, 22]
    .map((x, i) => `<circle cx="${x}" cy="${i === 1 ? 29 : 27}" r="1.7" fill="${SNOW}"/>`)
    .join("");
}

function drawing(icon: WeatherIcon, isDay: boolean): string {
  switch (icon) {
    case "clear":
      return isDay ? sun(16, 16, 6.5) : moon(16, 16, 8);
    case "partly":
      return `${isDay ? sun(22, 10, 4.5) : moon(23, 9, 6)}${cloud(isDay ? CLOUD : CLOUD_DARK, 2)}`;
    case "cloudy":
      return cloud(CLOUD_DARK, 1);
    case "fog":
      return `${cloud(CLOUD_DARK, -3)}<g stroke="${CLOUD}" stroke-width="2.2" stroke-linecap="round"><path d="M7 25h18"/><path d="M10 29h12"/></g>`;
    case "drizzle":
      return `${cloud(CLOUD, -3)}${drops(RAIN, [13, 20])}`;
    case "rain":
      return `${cloud(CLOUD_DARK, -3)}${drops(RAIN, [10, 16, 22])}`;
    case "snow":
      return `${cloud(CLOUD, -3)}${flakes()}`;
    case "thunder":
      return `${cloud(CLOUD_DARK, -3)}<path d="M17.5 19l-5 7h3.6l-1.6 5 6-7.5h-3.8l2.3-4.5z" fill="${BOLT}"/>`;
  }
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
