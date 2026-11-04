import { type CSSProperties, useEffect, useMemo, useState } from "react";
import { retryForecast, updateSettings } from "../controller";
import { formatCoords } from "../geo/coords";
import { formatDifference, formatOffset, zoneFor, zoneOffsetMinutes } from "../geo/timezone";
import { forecastForSelection, useStore } from "../store";
import { skyFor } from "../weather/conditions";
import type { Forecast } from "../weather/provider";
import { describeWeatherCode } from "../weather/wmo";
import { backdropFor } from "./backdrop";
import {
  compassPoint,
  formatAge,
  formatClock,
  formatDate,
  formatDayName,
  formatLocalHour,
  formatLocalTime,
  formatTemperature,
  formatWind,
} from "./format";
import { iconSrc } from "./icons";
import { WeatherIcon } from "./WeatherIcon";

/** Re-renders on each new second, so the clock never skips or lags. */
function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        1000 - (Date.now() % 1000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** `staleNote` says when the weather shown is older than it should be. */
function Headline({ data, staleNote }: { data: Forecast; staleNote: string | null }) {
  const unit = useStore((s) => s.settings.unit);
  const condition = describeWeatherCode(data.current.code);
  return (
    <div className="weather-headline" data-testid="weather">
      <WeatherIcon icon={condition.icon} isDay={data.current.isDay} size={56} />
      <div className="weather-temp" data-testid="temperature">
        {formatTemperature(data.current.temp, unit)}
      </div>
      <div className="weather-text">
        <div className="weather-condition">{condition.label}</div>
        {staleNote ? (
          <div className="weather-stale" role="status" data-testid="stale-note">
            {staleNote}
          </div>
        ) : (
          <div className="weather-feels">
            Feels like {formatTemperature(data.current.feelsLike, unit)}
          </div>
        )}
      </div>
    </div>
  );
}

function Stats({ data }: { data: Forecast }) {
  const { unit, hour12 } = useStore((s) => s.settings);
  const sunEvent = (value: string | null) =>
    value ? formatLocalTime(value, hour12) : "None today";
  return (
    <dl className="stats">
      <div>
        <dt>Wind</dt>
        <dd>
          {formatWind(data.current.wind, unit)}
          {data.current.windDirection !== null && data.current.wind >= 1 && (
            <span className="wind-from">
              <svg
                viewBox="0 0 16 16"
                aria-hidden="true"
                // Points where the wind blows to, away from where it comes from.
                style={{ transform: `rotate(${data.current.windDirection + 180}deg)` }}
              >
                <path d="M8 13.5V3M4.2 6.8L8 3l3.8 3.8" />
              </svg>
              from {compassPoint(data.current.windDirection)}
            </span>
          )}
        </dd>
      </div>
      <div>
        <dt>Humidity</dt>
        <dd>{Math.round(data.current.humidity)}%</dd>
      </div>
      <div>
        <dt>Sunrise</dt>
        <dd>{sunEvent(data.sunrise)}</dd>
      </div>
      <div>
        <dt>Sunset</dt>
        <dd>{sunEvent(data.sunset)}</dd>
      </div>
    </dl>
  );
}

function Hourly({ data }: { data: Forecast }) {
  const { unit, hour12 } = useStore((s) => s.settings);
  return (
    // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll this strip.
    <ul className="hourly" tabIndex={0} aria-label="Next hours">
      {data.hourly.map((hour) => {
        const condition = describeWeatherCode(hour.code);
        return (
          <li key={hour.time}>
            <span className="hourly-time">{formatLocalHour(hour.time, hour12)}</span>
            <img
              className="hourly-icon"
              src={iconSrc(condition.icon, hour.isDay)}
              alt={condition.label}
              width={28}
              height={28}
            />
            <span className="hourly-temp">{formatTemperature(hour.temp, unit)}</span>
            <span className="hourly-rain">
              {hour.precipChance !== null && hour.precipChance >= 10 && (
                <>
                  {Math.round(hour.precipChance)}%
                  <span className="sr-only"> chance of precipitation</span>
                </>
              )}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

/** The week ahead, each day's range drawn on one scale shared by the whole week. */
function Daily({ data }: { data: Forecast }) {
  const unit = useStore((s) => s.settings.unit);
  const days = data.daily;
  const first = days[0];
  if (!first) return null;
  const low = Math.min(...days.map((d) => d.low));
  const high = Math.max(...days.map((d) => d.high));
  const span = Math.max(1, high - low);
  return (
    <section className="daily" aria-label="Next 7 days">
      <h2 className="section-title">Next 7 days</h2>
      <ul>
        {days.map((day) => {
          const condition = describeWeatherCode(day.code);
          const start = ((day.low - low) / span) * 100;
          const width = Math.max(6, ((day.high - day.low) / span) * 100);
          return (
            <li key={day.date}>
              <span className="daily-day">{formatDayName(day.date, first.date)}</span>
              <img
                className="daily-icon"
                src={iconSrc(condition.icon, true)}
                alt={condition.label}
                width={24}
                height={24}
              />
              <span className="daily-rain">
                {day.precipChance !== null && day.precipChance >= 10 && (
                  <>
                    {Math.round(day.precipChance)}%
                    <span className="sr-only"> chance of precipitation</span>
                  </>
                )}
              </span>
              <span className="daily-low">
                <span className="sr-only">Low </span>
                {formatTemperature(day.low, unit)}
              </span>
              <span className="daily-range" aria-hidden="true">
                <span style={{ left: `${start}%`, width: `${Math.min(width, 100 - start)}%` }} />
              </span>
              <span className="daily-high">
                <span className="sr-only">High </span>
                {formatTemperature(day.high, unit)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string]>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{label}</legend>
      {options.map(([option, text]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  );
}

const TEMPERATURE_OPTIONS = [
  ["c", "°C"],
  ["f", "°F"],
] as const;

const CLOCK_OPTIONS = [
  ["12", "12h"],
  ["24", "24h"],
] as const;

export function InfoPanel() {
  const lat = useStore((s) => s.lat);
  const lon = useStore((s) => s.lon);
  const place = useStore((s) => s.place);
  const moving = useStore((s) => s.moving);
  const settings = useStore((s) => s.settings);
  const forecast = useStore(forecastForSelection);
  const now = useNow();
  const [expanded, setExpanded] = useState(false);

  const data = forecast?.data ?? null;
  const overOcean = place.kind === "ocean";
  const reportedZone = data?.timezone;
  const zone = useMemo(
    () => zoneFor(lat, lon, overOcean, reportedZone),
    [lat, lon, overOcean, reportedZone],
  );

  const offset = zoneOffsetMinutes(zone, now);
  const viewerOffset = -now.getTimezoneOffset();
  const isDay = data?.current.isDay ?? true;
  const condition = data ? describeWeatherCode(data.current.code) : null;
  const backdrop = condition ? backdropFor(condition.icon, isDay) : null;
  const intensity = data
    ? skyFor(data.current.code, { precipitation: data.current.precipitation }).precip
    : 0;
  const loading = !moving && (forecast === null || forecast.status === "loading");
  const age = forecast?.fetchedAt != null ? now.getTime() - forecast.fetchedAt : 0;
  const staleNote =
    forecast?.status === "error" ? `Couldn't refresh. From ${formatAge(age)}` : null;

  return (
    <section className={`panel${expanded ? " is-expanded" : ""}`} aria-label="Selected place">
      <button
        type="button"
        className="panel-handle"
        aria-expanded={expanded}
        aria-label={expanded ? "Show less" : "Show more"}
        onClick={() => setExpanded((value) => !value)}
      />

      <header className="place">
        <h1 data-testid="place-name">{place.name}</h1>
        <p>
          {place.region && <span>{place.region} · </span>}
          <span data-testid="coords">{formatCoords(lat, lon)}</span>
        </p>
      </header>

      <section className="clock" aria-label="Local time">
        <div className="clock-time" data-testid="clock">
          {formatClock(now, zone, settings.hour12)}
        </div>
        <div className="clock-meta">
          <span>{formatDate(now, zone)}</span>
          <span data-testid="utc-offset">{formatOffset(offset)}</span>
          <span>{formatDifference(offset, viewerOffset)}</span>
        </div>
      </section>

      <section
        className={`weather${isDay ? "" : " is-night"}`}
        aria-label="Weather"
        aria-busy={loading}
        data-backdrop={backdrop ?? undefined}
      >
        {backdrop && (
          <div
            className="weather-backdrop"
            aria-hidden="true"
            style={{ "--intensity": Math.max(0.35, intensity).toFixed(2) } as CSSProperties}
          />
        )}
        {data ? (
          <div
            key={forecast?.key}
            className={`weather-body${forecast?.status === "loading" ? " is-refreshing" : ""}`}
          >
            <Headline data={data} staleNote={staleNote} />
          </div>
        ) : forecast?.status === "error" ? (
          <div className="weather-empty" role="status" data-testid="weather-error">
            <span>Weather isn't available right now.</span>
            <button type="button" className="link-button" onClick={retryForecast}>
              Try again
            </button>
          </div>
        ) : (
          <div className="weather-empty" data-testid="weather-pending">
            {moving ? (
              "Stop to see the weather here"
            ) : (
              <span className="skeleton">Loading weather…</span>
            )}
          </div>
        )}
      </section>

      <div className="details">
        {data && (
          <>
            <Stats data={data} />
            <Hourly data={data} />
            <Daily data={data} />
          </>
        )}
        {forecast?.status === "ready" && <p className="status-line">Updated {formatAge(age)}</p>}
        <div className="settings">
          <Segmented
            label="Temperature unit"
            value={settings.unit}
            options={TEMPERATURE_OPTIONS}
            onChange={(unit) => updateSettings({ unit })}
          />
          <Segmented
            label="Clock format"
            value={settings.hour12 ? "12" : "24"}
            options={CLOCK_OPTIONS}
            onChange={(value) => updateSettings({ hour12: value === "12" })}
          />
        </div>
      </div>

      <footer className="credits">
        <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
          Weather data by Open-Meteo
        </a>
        {" · "}
        <a href="https://www.geonames.org/" target="_blank" rel="noreferrer">
          GeoNames
        </a>
        {" · "}
        <a href="https://www.naturalearthdata.com/" target="_blank" rel="noreferrer">
          Natural Earth
        </a>
        {" · "}
        <a
          href="https://science.nasa.gov/earth/earth-observatory/collections/blue-marble"
          target="_blank"
          rel="noreferrer"
        >
          NASA imagery
        </a>
      </footer>
    </section>
  );
}
