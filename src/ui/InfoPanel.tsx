import { useEffect, useMemo, useRef, useState } from "react";
import { retryForecast, updateSettings } from "../controller";
import { formatCoords } from "../geo/coords";
import { polarState } from "../geo/sun";
import {
  formatDifference,
  formatOffset,
  relativeDay,
  zoneFor,
  zoneOffsetMinutes,
} from "../geo/timezone";
import { forecastForSelection, useStore } from "../store";
import type { Forecast, WeatherProblem } from "../weather/provider";
import { describeWeatherCode } from "../weather/wmo";
import {
  formatAge,
  formatClock,
  formatDate,
  formatLocalHour,
  formatLocalTime,
  formatTemperature,
  formatWind,
} from "./format";
import { iconSrc } from "./icons";

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
      <img
        className="weather-icon"
        src={iconSrc(condition.icon, data.current.isDay)}
        alt=""
        width={56}
        height={56}
      />
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

/** What to say when there's no sunrise or sunset today. */
function polarText(lat: number, now: Date): { title: string; detail: string } {
  const polar = polarState(lat, now);
  if (polar === "day") return { title: "Midnight sun", detail: "The sun stays up all day" };
  if (polar === "night") return { title: "Polar night", detail: "The sun stays down all day" };
  return { title: "No sunrise or sunset", detail: "Not today at this place" };
}

function Stats({ data, lat, now }: { data: Forecast; lat: number; now: Date }) {
  const { unit, hour12 } = useStore((s) => s.settings);
  const polar = data.sunrise === null || data.sunset === null ? polarText(lat, now) : null;
  return (
    <dl className="stats">
      <div>
        <dt>Wind</dt>
        <dd>{formatWind(data.current.wind, unit)}</dd>
      </div>
      <div>
        <dt>Humidity</dt>
        <dd>{Math.round(data.current.humidity)}%</dd>
      </div>
      {polar ? (
        <div className="stats-wide" data-testid="polar">
          <dt>{polar.detail}</dt>
          <dd>{polar.title}</dd>
        </div>
      ) : (
        <>
          <div>
            <dt>Sunrise</dt>
            <dd>{formatLocalTime(data.sunrise ?? "", hour12)}</dd>
          </div>
          <div>
            <dt>Sunset</dt>
            <dd>{formatLocalTime(data.sunset ?? "", hour12)}</dd>
          </div>
        </>
      )}
    </dl>
  );
}

/** Scrolls by whole hours; arrows for mouse users, swipes and arrow keys for the rest. */
function Hourly({ data }: { data: Forecast }) {
  const { unit, hour12 } = useStore((s) => s.settings);
  const listRef = useRef<HTMLUListElement>(null);
  const [edges, setEdges] = useState({ atStart: true, atEnd: false });

  const measure = () => {
    const list = listRef.current;
    if (!list) return;
    setEdges({
      atStart: list.scrollLeft <= 2,
      atEnd: list.scrollLeft + list.clientWidth >= list.scrollWidth - 2,
    });
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the hours change.
  useEffect(measure, [data]);

  const page = (direction: 1 | -1) => {
    const list = listRef.current;
    if (!list) return;
    const smooth = !matchMedia("(prefers-reduced-motion: reduce)").matches;
    list.scrollBy({ left: direction * list.clientWidth, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <div
      className="hourly-wrap"
      data-at-start={edges.atStart || undefined}
      data-at-end={edges.atEnd || undefined}
    >
      <ul
        ref={listRef}
        className="hourly"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: keyboard users need focus to scroll this strip.
        tabIndex={0}
        aria-label="Next 24 hours"
        onScroll={measure}
      >
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
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="hourly-page is-prev"
        aria-label="Earlier hours"
        tabIndex={-1}
        disabled={edges.atStart}
        onClick={() => page(-1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 6l-6 6 6 6" />
        </svg>
      </button>
      <button
        type="button"
        className="hourly-page is-next"
        aria-label="Later hours"
        tabIndex={-1}
        disabled={edges.atEnd}
        onClick={() => page(1)}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9.5 6l6 6-6 6" />
        </svg>
      </button>
    </div>
  );
}

const PROBLEM_TEXT: Readonly<Record<WeatherProblem, string>> = {
  offline: "You're offline. The weather will load once you reconnect.",
  busy: "The weather service is busy right now.",
  timeout: "The weather service didn't answer in time.",
  unavailable: "Weather isn't available right now.",
};

function retryText(retryAt: number | null, now: Date): string {
  if (retryAt === null) return "";
  const seconds = Math.max(1, Math.ceil((retryAt - now.getTime()) / 1000));
  return seconds < 90
    ? `Trying again in ${seconds} s.`
    : `Trying again in ${Math.round(seconds / 60)} min.`;
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
  const day = relativeDay(now, zone);
  const isDay = data?.current.isDay ?? true;
  const loading = !moving && (forecast === null || forecast.status === "loading");
  const age = forecast?.fetchedAt != null ? now.getTime() - forecast.fetchedAt : 0;
  const staleNote =
    forecast?.status === "error"
      ? `${forecast.problem === "offline" ? "Offline" : "Couldn't refresh"}. From ${formatAge(age)}`
      : null;

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
          <span>
            {formatDate(now, zone)}
            {day !== "today" && <span className="clock-day"> ({day})</span>}
          </span>
          <span data-testid="utc-offset">{formatOffset(offset)}</span>
          <span>{formatDifference(offset, viewerOffset)}</span>
        </div>
      </section>

      <section
        className={`weather${isDay ? "" : " is-night"}`}
        aria-label="Weather"
        aria-busy={loading}
      >
        {data ? (
          <div className={forecast?.status === "loading" ? "is-refreshing" : undefined}>
            <Headline data={data} staleNote={staleNote} />
          </div>
        ) : forecast?.status === "error" ? (
          <div className="weather-empty" role="status" data-testid="weather-error">
            <span>
              {PROBLEM_TEXT[forecast.problem ?? "unavailable"]} {retryText(forecast.retryAt, now)}
            </span>
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
            <Stats data={data} lat={lat} now={now} />
            <Hourly data={data} />
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
      </footer>
    </section>
  );
}
