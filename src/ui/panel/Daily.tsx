import { useStore } from "../../store";
import type { Forecast } from "../../weather/provider";
import { describeWeatherCode } from "../../weather/wmo";
import { formatDayName, formatTemperature } from "../format";
import { iconSrc } from "../icons";

/** The week ahead, each day's range drawn on one scale shared by the whole week. */
export function Daily({ data }: { data: Forecast }) {
  const unit = useStore((s) => s.settings.unit);
  const days = data.daily;
  if (days.length === 0) return null;
  const low = Math.min(...days.map((d) => d.min));
  const high = Math.max(...days.map((d) => d.max));
  const span = Math.max(1, high - low);
  const at = (value: number) => `${(((value - low) / span) * 100).toFixed(1)}%`;

  return (
    <section className="daily" aria-label="7-day forecast">
      <h2 className="section-title">7-day forecast</h2>
      <ol className="daily-list">
        {days.map((day, i) => {
          const condition = describeWeatherCode(day.code);
          const chance = day.precipChance ?? 0;
          const name = formatDayName(day.date, i);
          return (
            <li
              key={day.date}
              aria-label={`${name}: ${condition.label}, high ${formatTemperature(day.max, unit)}, low ${formatTemperature(day.min, unit)}${chance >= 10 ? `, ${chance}% chance of rain or snow` : ""}`}
            >
              <span className="daily-name" aria-hidden="true">
                {name}
              </span>
              <img
                className="daily-icon"
                src={iconSrc(condition.icon, true)}
                alt=""
                width={28}
                height={28}
              />
              <span className="daily-rain" aria-hidden="true">
                {chance >= 10 ? `${chance}%` : ""}
              </span>
              <span className="daily-min" aria-hidden="true">
                {formatTemperature(day.min, unit)}
              </span>
              <span className="daily-range" aria-hidden="true">
                <span
                  className="daily-bar"
                  style={{ left: at(day.min), right: `calc(100% - ${at(day.max)})` }}
                />
                {i === 0 && (
                  <span
                    className="daily-now"
                    style={{ left: at(Math.min(high, Math.max(low, data.current.temp))) }}
                  />
                )}
              </span>
              <span className="daily-max" aria-hidden="true">
                {formatTemperature(day.max, unit)}
              </span>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
