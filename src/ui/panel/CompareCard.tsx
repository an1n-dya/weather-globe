import { useMemo } from "react";
import { setCompare } from "../../controller";
import { formatDuration, zoneFor, zoneOffsetMinutes } from "../../geo/timezone";
import type { SavedPlace } from "../../savedPlaces";
import { useStore } from "../../store";
import { formatShortTime } from "../time";
import { Icon } from "./Icon";

/** A pinned place's clock beside the one under the reticle, and how far apart they are. */
export function CompareCard({
  pinned,
  now,
  name,
  offset,
}: {
  pinned: SavedPlace;
  now: Date;
  name: string;
  offset: number;
}) {
  const hour12 = useStore((s) => s.settings.hour12);
  const zone = useMemo(() => zoneFor(pinned.lat, pinned.lon, false), [pinned.lat, pinned.lon]);
  const diff = offset - zoneOffsetMinutes(zone, now);
  const relation =
    diff === 0
      ? `${name} has the same time as ${pinned.name}`
      : `${name} is ${formatDuration(diff)} ${diff > 0 ? "ahead of" : "behind"} ${pinned.name}`;
  return (
    <section className="compare" aria-label="Compare times" data-testid="compare">
      <div className="compare-row">
        <span className="compare-label">Comparing with</span>
        <span className="compare-name">{pinned.name}</span>
        <span className="compare-time">{formatShortTime(now, zone, hour12)}</span>
        <button
          type="button"
          className="icon-button is-small"
          aria-label="Stop comparing"
          title="Stop comparing"
          onClick={() => setCompare(null)}
        >
          <Icon name="close" />
        </button>
      </div>
      <p className="compare-diff" data-testid="compare-difference">
        {relation}
      </p>
    </section>
  );
}
