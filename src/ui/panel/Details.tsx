import type { ReactNode } from "react";
import { memo } from "react";
import { useStore } from "../../store";
import type { Forecast } from "../../weather/provider";
import {
  compassWords,
  formatPressure,
  formatTemperature,
  formatVisibility,
  formatWind,
  uvLevel,
} from "../format";

function Card({
  title,
  value,
  note,
  children,
}: {
  title: string;
  value: string;
  note?: string;
  children?: ReactNode;
}) {
  return (
    <div className="detail">
      <dt>{title}</dt>
      <dd>
        <span className={value === MISSING ? "detail-value is-missing" : "detail-value"}>
          {value}
        </span>
        {children}
        {note && <span className="detail-note">{note}</span>}
      </dd>
    </div>
  );
}

/** Shown in place of a value the service didn't report here, rather than a dash or a zero. */
const MISSING = "Not reported";

export const Details = memo(function Details({ data }: { data: Forecast }) {
  const { unit, wind } = useStore((s) => s.settings);
  const c = data.current;
  const uv = c.uvIndex ?? data.daily[0]?.uvMax ?? null;
  return (
    <section className="details-section" aria-label="Conditions">
      <h2 className="section-title">Conditions</h2>
      <dl className="details-grid">
        <Card
          title="Wind"
          value={formatWind(c.wind, wind)}
          note={[
            c.windDirection !== null ? `From the ${compassWords(c.windDirection)}` : "",
            c.windGusts !== null ? `gusts ${formatWind(c.windGusts, wind)}` : "",
          ]
            .filter(Boolean)
            .join(", ")}
        >
          {c.windDirection !== null && (
            <svg
              className="wind-arrow"
              viewBox="0 0 24 24"
              aria-hidden="true"
              // Points the way the wind blows: from its compass point, downwind.
              style={{ transform: `rotate(${c.windDirection + 180}deg)` }}
            >
              <path d="M12 3l5 9h-3.5v9h-3v-9H7z" />
            </svg>
          )}
        </Card>
        <Card
          title="Humidity"
          value={`${Math.round(c.humidity)}%`}
          note={
            c.dewPoint !== null ? `Dew point ${formatTemperature(c.dewPoint, unit)}` : undefined
          }
        />
        <Card
          title="UV index"
          value={uv === null ? MISSING : String(Math.round(uv))}
          note={uv === null ? undefined : uvLevel(uv)}
        >
          {uv !== null && (
            <span className="uv-scale" aria-hidden="true">
              <span style={{ left: `${Math.min(100, (uv / 11) * 100)}%` }} />
            </span>
          )}
        </Card>
        <Card
          title="Pressure"
          value={c.pressure === null ? MISSING : formatPressure(c.pressure, unit)}
          note="At sea level"
        />
        <Card
          title="Visibility"
          value={c.visibility === null ? MISSING : formatVisibility(c.visibility, wind)}
        />
        <Card
          title="Cloud cover"
          value={c.cloudCover === null ? MISSING : `${Math.round(c.cloudCover)}%`}
        />
      </dl>
    </section>
  );
});
