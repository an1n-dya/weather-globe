import { type PointerEvent, useMemo, useRef } from "react";
import { retryForecast } from "../controller";
import { sunDay, sunPhase } from "../geo/sun";
import { zoneFor, zoneOffsetMinutes } from "../geo/timezone";
import { forecastForSelection, useStore } from "../store";
import type { WeatherProblem } from "../weather/provider";
import { describeWeatherCode } from "../weather/wmo";
import { formatAge, formatTemperature } from "./format";
import { useNow } from "./hooks";
import { ClockSection } from "./panel/ClockSection";
import { CompareCard } from "./panel/CompareCard";
import { Credits } from "./panel/Credits";
import { Daily } from "./panel/Daily";
import { Details } from "./panel/Details";
import { Hourly } from "./panel/Hourly";
import { PlaceHeader } from "./panel/PlaceHeader";
import { SettingsSection } from "./panel/SettingsSection";
import { WeatherSkeleton } from "./panel/Skeleton";
import { SunArc } from "./panel/SunArc";
import { WeatherNow } from "./panel/WeatherNow";
import { minutesInZone } from "./time";

export type SheetState = "collapsed" | "half" | "full";
export type PanelLayout = "side" | "sheet";

const ORDER: readonly SheetState[] = ["collapsed", "half", "full"];
/** A flick faster than this, in px/ms, moves the sheet on a step. */
const FLING = 0.45;

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

interface Props {
  layout: PanelLayout;
  sheet: SheetState;
  onSheet: (state: SheetState) => void;
  /** Visible height of the sheet in each state, in pixels. */
  heights: Readonly<Record<SheetState, number>>;
}

export function InfoPanel({ layout, sheet, onSheet, heights }: Props) {
  const lat = useStore((s) => s.lat);
  const lon = useStore((s) => s.lon);
  const place = useStore((s) => s.place);
  const moving = useStore((s) => s.moving);
  const unit = useStore((s) => s.settings.unit);
  const compare = useStore((s) => s.compare);
  const forecast = useStore(forecastForSelection);
  const now = useNow();

  const data = forecast?.data ?? null;
  const overOcean = place.kind === "ocean";
  const reportedZone = data?.timezone;
  const zone = useMemo(
    () => zoneFor(lat, lon, overOcean, reportedZone),
    [lat, lon, overOcean, reportedZone],
  );
  const offset = zoneOffsetMinutes(zone, now);
  const minutes = minutesInZone(now, zone);
  const minuteKey = Math.floor(now.getTime() / 60_000);
  // biome-ignore lint/correctness/useExhaustiveDependencies: recomputed once a minute, not every second.
  const sun = useMemo(() => sunDay(lat, lon, now, minutes), [lat, lon, zone, minuteKey]);

  const isDay = data?.current.isDay ?? sunPhase(sun, minutes).isDay;
  const loading = !moving && (forecast === null || forecast.status === "loading");
  const age = forecast?.fetchedAt != null ? now.getTime() - forecast.fetchedAt : 0;
  const staleNote =
    forecast?.status === "error"
      ? `${forecast.problem === "offline" ? "Offline" : "Couldn't refresh"}. From ${formatAge(age)}`
      : null;

  const summary = data
    ? `${[place.name, place.region].filter(Boolean).join(", ")}. ${formatTemperature(data.current.temp, unit)}, ${describeWeatherCode(data.current.code).label.toLowerCase()}.`
    : "";

  // Dragging the sheet: the inline height follows the finger, then the state takes over.
  const panelRef = useRef<HTMLElement>(null);
  const drag = useRef<{
    id: number;
    startY: number;
    startHeight: number;
    lastY: number;
    lastTime: number;
    velocity: number;
    moved: boolean;
  } | null>(null);
  /** Set after a drag, so the release doesn't also count as a tap on the handle. */
  const dragged = useRef(false);

  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    if (layout !== "sheet" || (event.pointerType === "mouse" && event.button !== 0)) return;
    const target = event.target as Element;
    // Buttons, links and the hour strip keep their own gestures; the handle always drags.
    if (!target.closest(".sheet-handle") && target.closest("button, a, input, .hourly")) return;
    // Full and scrolled down, the content scrolls instead.
    if (
      sheet === "full" &&
      (panelRef.current?.scrollTop ?? 0) > 0 &&
      !target.closest(".sheet-handle")
    ) {
      return;
    }
    drag.current = {
      id: event.pointerId,
      startY: event.clientY,
      startHeight: heights[sheet],
      lastY: event.clientY,
      lastTime: event.timeStamp,
      velocity: 0,
      moved: false,
    };
    dragged.current = false;
    // Captured from the start, so a quick flick that leaves the sheet still reaches it.
    // The pressed element captures, so a plain tap on the handle still clicks it.
    try {
      (target.closest(".sheet-handle") ?? event.currentTarget).setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events can't be captured.
    }
  };

  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    if (!state || !panel || state.id !== event.pointerId) return;
    const dy = state.startY - event.clientY;
    if (!state.moved && Math.abs(dy) < 6) return;
    if (!state.moved) {
      state.moved = true;
      panel.classList.add("is-dragging");
    }
    const height = Math.max(heights.collapsed, Math.min(heights.full, state.startHeight + dy));
    panel.style.setProperty("--sheet-visible", `${height}px`);
    const dt = Math.max(1, event.timeStamp - state.lastTime);
    state.velocity = (state.lastY - event.clientY) / dt;
    state.lastY = event.clientY;
    state.lastTime = event.timeStamp;
  };

  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    const panel = panelRef.current;
    drag.current = null;
    if (!state || !panel || state.id !== event.pointerId || !state.moved) return;
    dragged.current = true;
    panel.classList.remove("is-dragging");
    panel.style.removeProperty("--sheet-visible");
    const height = Math.max(
      heights.collapsed,
      Math.min(heights.full, state.startHeight + state.startY - event.clientY),
    );
    let target: SheetState;
    if (Math.abs(state.velocity) > FLING) {
      // A flick goes one step in its direction from wherever it was let go.
      const below = [...ORDER].reverse().find((s) => heights[s] <= height) ?? "collapsed";
      const above = ORDER.find((s) => heights[s] >= height) ?? "full";
      target = state.velocity > 0 ? above : below;
      if (target === sheet) {
        const i = ORDER.indexOf(sheet) + (state.velocity > 0 ? 1 : -1);
        target = ORDER[Math.max(0, Math.min(ORDER.length - 1, i))] ?? sheet;
      }
    } else {
      target = ORDER.reduce((best, s) =>
        Math.abs(heights[s] - height) < Math.abs(heights[best] - height) ? s : best,
      );
    }
    onSheet(target);
  };

  const stepSheet = () => {
    // The click that ends a drag isn't a tap.
    if (dragged.current) {
      dragged.current = false;
      return;
    }
    onSheet(sheet === "collapsed" ? "half" : sheet === "half" ? "full" : "collapsed");
  };

  return (
    <section
      ref={panelRef}
      className="panel"
      data-layout={layout}
      data-sheet={layout === "sheet" ? sheet : undefined}
      aria-label="Selected place"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onFocus={(event) => {
        // Tabbing into a part of the sheet that's off screen brings it all up.
        if (
          layout === "sheet" &&
          sheet !== "full" &&
          (event.target as Element).closest(".panel-more")
        ) {
          onSheet("full");
        }
      }}
    >
      {layout === "sheet" && (
        <button
          type="button"
          className="sheet-handle"
          aria-expanded={sheet !== "collapsed"}
          aria-label={sheet === "full" ? "Show less" : "Show more"}
          onClick={stepSheet}
        />
      )}

      <div className="panel-peek">
        <PlaceHeader />
        <ClockSection now={now} zone={zone} offset={offset} minutes={minutes} sun={sun} />
        <section
          className={`weather${isDay ? "" : " is-night"}`}
          aria-label="Weather"
          aria-busy={loading}
        >
          {data ? (
            <div className={forecast?.status === "loading" ? "is-refreshing" : undefined}>
              <WeatherNow data={data} staleNote={staleNote} />
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
                <span className="skeleton-text">Loading weather…</span>
              )}
            </div>
          )}
        </section>
      </div>

      <div className="panel-more">
        {compare && <CompareCard pinned={compare} now={now} name={place.name} offset={offset} />}
        {data ? (
          <>
            {forecast?.status === "ready" && (
              <p className="status-line" data-testid="updated">
                Updated {formatAge(age)}
              </p>
            )}
            <Hourly data={data} />
            <Daily data={data} />
            <Details data={data} />
          </>
        ) : (
          // Kept while there's nothing to show, so the panel never changes shape; it only
          // pulses while the weather is actually on its way.
          <WeatherSkeleton still={!loading} />
        )}
        <SunArc sun={sun} minutes={minutes} />
        <SettingsSection />
        <Credits />
      </div>
      <p className="sr-only" data-testid="summary">
        {summary}
      </p>
    </section>
  );
}
