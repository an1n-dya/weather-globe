import { memo, useEffect, useRef, useState } from "react";
import { useStore } from "../../store";
import type { Forecast } from "../../weather/provider";
import { describeWeatherCode } from "../../weather/wmo";
import { formatLocalHour, formatTemperature } from "../format";
import { REDUCED_MOTION_QUERY } from "../hooks";
import { iconSrc } from "../icons";
import { Icon } from "./Icon";

/** Scrolls by whole hours; arrows for mouse users, swipes and arrow keys for the rest. */
export const Hourly = memo(function Hourly({ data }: { data: Forecast }) {
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
    const smooth = !matchMedia(REDUCED_MOTION_QUERY).matches;
    list.scrollBy({ left: direction * list.clientWidth, behavior: smooth ? "smooth" : "auto" });
  };

  return (
    <section className="hourly-section" aria-label="Next 24 hours">
      <h2 className="section-title">Next 24 hours</h2>
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
            const chance = hour.precipChance ?? 0;
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
                <span className="hourly-rain" aria-hidden="true">
                  {chance >= 10 ? `${chance}%` : ""}
                </span>
                {chance >= 10 && <span className="sr-only">{chance}% chance of rain or snow</span>}
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
          <Icon name="chevronLeft" />
        </button>
        <button
          type="button"
          className="hourly-page is-next"
          aria-label="Later hours"
          tabIndex={-1}
          disabled={edges.atEnd}
          onClick={() => page(1)}
        >
          <Icon name="chevronRight" />
        </button>
      </div>
    </section>
  );
});
