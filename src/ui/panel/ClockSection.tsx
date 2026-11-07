import type { SunDay } from "../../geo/sun";
import { formatDifference, formatOffset, relativeDay } from "../../geo/timezone";
import { useStore } from "../../store";
import { formatClock, formatDate } from "../format";

/** Midnight to midnight, with daylight shaded and a mark for now. */
function DayProgress({ minutes, sun }: { minutes: number; sun: SunDay }) {
  const percent = (value: number) => `${((value / 1440) * 100).toFixed(2)}%`;
  const rise = sun.sunrise ?? (sun.polar === "day" ? 0 : sun.sunset === null ? 1440 : 0);
  const set = sun.sunset ?? (sun.polar === "night" ? 0 : 1440);
  // Near the polar circles the sun can set after midnight and rise again before dawn.
  const wraps = sun.sunrise !== null && sun.sunset !== null && sun.sunset < sun.sunrise;
  const label = `${Math.round((minutes / 1440) * 100)}% of the local day has passed`;
  return (
    <div className="day-progress" role="img" aria-label={label}>
      <div
        className="day-track"
        data-wraps={wraps || undefined}
        style={
          {
            "--rise": percent(wraps ? rise : Math.min(rise, set)),
            "--set": percent(set),
          } as React.CSSProperties
        }
      >
        <span className="day-now" style={{ left: percent(minutes) }} />
      </div>
      <div className="day-ticks" aria-hidden="true">
        <span>0</span>
        <span>6</span>
        <span>12</span>
        <span>18</span>
        <span>24</span>
      </div>
    </div>
  );
}

export function ClockSection({
  now,
  zone,
  offset,
  minutes,
  sun,
}: {
  now: Date;
  zone: string;
  offset: number;
  minutes: number;
  sun: SunDay;
}) {
  const hour12 = useStore((s) => s.settings.hour12);
  const day = relativeDay(now, zone);
  return (
    <section className="clock" aria-label="Local time">
      <div className="clock-time" data-testid="clock">
        {formatClock(now, zone, hour12)}
      </div>
      <div className="clock-meta">
        <span>
          {formatDate(now, zone)}
          {day !== "today" && <span className="clock-day"> ({day})</span>}
        </span>
        <span data-testid="utc-offset">{formatOffset(offset)}</span>
        <span data-testid="difference">{formatDifference(offset, -now.getTimezoneOffset())}</span>
      </div>
      <DayProgress minutes={minutes} sun={sun} />
    </section>
  );
}
