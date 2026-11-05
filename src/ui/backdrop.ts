import type { WeatherIcon } from "../weather/wmo";

export type Backdrop = "sun" | "stars" | "clouds" | "rain" | "snow" | "storm" | "fog";

/** The animated scene behind the current weather. */
export function backdropFor(icon: WeatherIcon, isDay: boolean): Backdrop {
  switch (icon) {
    case "clear":
      return isDay ? "sun" : "stars";
    case "partly":
    case "cloudy":
      return "clouds";
    case "fog":
      return "fog";
    case "drizzle":
    case "rain":
      return "rain";
    case "snow":
      return "snow";
    case "thunder":
      return "storm";
  }
}
