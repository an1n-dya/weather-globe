import type { Forecast } from "../../weather/provider";
import { Daily } from "./Daily";
import { Details } from "./Details";
import { Hourly } from "./Hourly";

/** A typical forecast. Only its shape shows: every value is drawn as a placeholder. */
const PLACEHOLDER: Forecast = {
  timezone: "UTC",
  current: {
    time: "2026-01-01T12:00",
    temp: 10,
    feelsLike: 8,
    humidity: 70,
    wind: 12,
    code: 3,
    isDay: true,
    windDirection: 200,
    windGusts: 25,
    dewPoint: 5,
    pressure: 1013,
    cloudCover: 60,
    visibility: 20_000,
    uvIndex: 2,
  },
  hourly: Array.from({ length: 24 }, (_, i) => ({
    time: `2026-01-01T${String(i).padStart(2, "0")}:00`,
    temp: 10,
    code: 3,
    isDay: true,
    precipChance: 20,
  })),
  daily: Array.from({ length: 7 }, (_, i) => ({
    date: `2026-01-0${i + 1}`,
    code: 3,
    max: 12,
    min: 4,
    precipChance: 20,
    sunrise: null,
    sunset: null,
    uvMax: 2,
    daylight: 36_000,
  })),
  sunrise: null,
  sunset: null,
  daylight: 36_000,
};

/**
 * The forecast's own sections, drawn as placeholders: the panel has its final
 * shape before the weather lands, so nothing below it jumps when it does.
 * `still` stops the pulse, for when nothing is on its way, such as after a failure.
 */
export function WeatherSkeleton({ still = false }: { still?: boolean }) {
  return (
    <div className="weather-skeleton" data-still={still || undefined} aria-hidden="true" inert>
      <p className="status-line">
        <span>Updated just now</span>
      </p>
      <Hourly data={PLACEHOLDER} />
      <Daily data={PLACEHOLDER} />
      <Details data={PLACEHOLDER} />
    </div>
  );
}
