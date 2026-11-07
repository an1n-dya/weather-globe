import { useStore } from "../../store";
import type { Forecast } from "../../weather/provider";
import { describeWeatherCode } from "../../weather/wmo";
import { formatTemperature } from "../format";
import { iconSrc } from "../icons";

/** `staleNote` says when the weather shown is older than it should be. */
export function WeatherNow({ data, staleNote }: { data: Forecast; staleNote: string | null }) {
  const unit = useStore((s) => s.settings.unit);
  const condition = describeWeatherCode(data.current.code);
  const today = data.daily[0];
  return (
    <div className="weather-headline" data-testid="weather">
      <img
        className="weather-icon"
        src={iconSrc(condition.icon, data.current.isDay)}
        alt=""
        width={64}
        height={64}
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
            {today && (
              <span className="weather-range">
                {" · "}H {formatTemperature(today.max, unit)} L {formatTemperature(today.min, unit)}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
