import type { WeatherIcon as Icon } from "../weather/wmo";
import {
  BOLT_PATH,
  CLOUD_PATH,
  FLAKES,
  FOG_PATHS,
  ICON_COLORS,
  iconLayout,
  MOON_PATH,
  sunRays,
} from "./icons";

/**
 * The current conditions, drawn inline so its parts can move: rays turn, cloud
 * drifts, rain and snow fall. The stylesheet stops it all for reduced motion.
 */
export function WeatherIcon({ icon, isDay, size }: { icon: Icon; isDay: boolean; size: number }) {
  const layout = iconLayout(icon, isDay);
  const c = ICON_COLORS;
  return (
    <svg
      className={`weather-icon wi wi-${icon}`}
      viewBox="0 0 32 32"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {layout.sun && (
        <g className="wi-sun">
          <circle cx={layout.sun.cx} cy={layout.sun.cy} r={layout.sun.r} fill={c.sun} />
          <g className="wi-rays" stroke={c.sun} strokeWidth={2} strokeLinecap="round">
            {sunRays(layout.sun.cx, layout.sun.cy, layout.sun.r).map(([x1, y1, x2, y2]) => (
              <line key={`${x1},${y1}`} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        </g>
      )}
      {layout.moon && (
        <path
          className="wi-moon"
          transform={`translate(${layout.moon.cx - layout.moon.r} ${layout.moon.cy - layout.moon.r}) scale(${layout.moon.r / 8})`}
          d={MOON_PATH}
          fill={c.moon}
        />
      )}
      {layout.cloud && (
        <g transform={`translate(0 ${layout.cloud.dy})`}>
          <path className="wi-cloud" d={CLOUD_PATH} fill={layout.cloud.color} />
        </g>
      )}
      {layout.drops.map((x) => (
        <path
          key={x}
          className="wi-drop"
          d={`M${x} 24.5l-1.6 4.5`}
          stroke={c.rain}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
      ))}
      {layout.flakes &&
        FLAKES.map(([x, y]) => (
          <circle key={x} className="wi-flake" cx={x} cy={y} r={1.7} fill={c.snow} />
        ))}
      {layout.bolt && <path className="wi-bolt" d={BOLT_PATH} fill={c.bolt} />}
      {layout.fog && (
        <g stroke={c.cloud} strokeWidth={2.2} strokeLinecap="round">
          {FOG_PATHS.map((d) => (
            <path key={d} className="wi-fog" d={d} />
          ))}
        </g>
      )}
    </svg>
  );
}
