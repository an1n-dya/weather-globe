import { type SunDay, sunPhase } from "../../geo/sun";
import { formatDuration } from "../../geo/timezone";
import { useStore } from "../../store";
import { formatDayLength } from "../format";
import { formatMinutes } from "../time";

const W = 280;
const H = 128;
const HORIZON = 92;
const LEFT = 24;
const RIGHT = W - 24;
/** Control points: the curves reach halfway to these, an apex at 41 and a dip at 112. */
const PEAK = -10;
const LOW = 132;

/** A point on the quadratic curve from (x0, y) through a control point to (x1, y). */
function along(t: number, x0: number, x1: number, y: number, control: number): [number, number] {
  const u = 1 - t;
  const cx = (x0 + x1) / 2;
  return [u * u * x0 + 2 * u * t * cx + t * t * x1, u * u * y + 2 * u * t * control + t * t * y];
}

/**
 * The day as an arc: the sun climbs from sunrise on the left to sunset on the
 * right, and after dark travels back under the horizon.
 */
export function SunArc({ sun, minutes }: { sun: SunDay; minutes: number }) {
  const hour12 = useStore((s) => s.settings.hour12);

  if (sun.polar) {
    return (
      <section className="sun" aria-label="Sun" data-testid="polar">
        <h2 className="section-title">Sun</h2>
        <p className="sun-polar">
          <strong>{sun.polar === "day" ? "Midnight sun" : "Polar night"}</strong>
          <span>
            {sun.polar === "day" ? "The sun stays up all day" : "The sun stays down all day"}
          </span>
        </p>
      </section>
    );
  }

  const phase = sunPhase(sun, minutes);
  const [x, y] = phase.isDay
    ? along(phase.progress, LEFT, RIGHT, HORIZON, PEAK)
    : along(phase.progress, RIGHT, LEFT, HORIZON, LOW);
  const next = phase.next
    ? `${phase.next.event === "sunrise" ? "Sunrise" : "Sunset"} in ${formatDuration(phase.next.minutes)}`
    : "";

  return (
    <section className="sun" aria-label="Sun">
      <h2 className="section-title">Sun</h2>
      <svg className="sun-arc" viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
        <path
          className="sun-path is-day"
          d={`M${LEFT} ${HORIZON} Q${W / 2} ${PEAK} ${RIGHT} ${HORIZON}`}
        />
        <path
          className="sun-path is-night"
          d={`M${LEFT} ${HORIZON} Q${W / 2} ${LOW} ${RIGHT} ${HORIZON}`}
        />
        <line className="sun-horizon" x1={8} y1={HORIZON} x2={W - 8} y2={HORIZON} />
        <circle
          className={phase.isDay ? "sun-dot" : "sun-dot is-night"}
          cx={x}
          cy={Math.min(y, 108)}
          r={7}
        />
      </svg>
      <dl className="sun-times">
        <div>
          <dt>Sunrise</dt>
          <dd>{sun.sunrise === null ? "None" : formatMinutes(sun.sunrise, hour12)}</dd>
        </div>
        <div>
          <dt>Daylight</dt>
          <dd>{formatDayLength(sun.daylight * 60)}</dd>
        </div>
        <div>
          <dt>Sunset</dt>
          <dd>{sun.sunset === null ? "None" : formatMinutes(sun.sunset, hour12)}</dd>
        </div>
      </dl>
      {next && <p className="sun-next">{next}</p>}
    </section>
  );
}
