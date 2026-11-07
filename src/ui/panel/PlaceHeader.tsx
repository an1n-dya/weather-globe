import { currentPlace, setCompare, shareView, toggleFavorite } from "../../controller";
import { formatCoords } from "../../geo/coords";
import { samePlace } from "../../savedPlaces";
import { useStore } from "../../store";
import { Icon } from "./Icon";

export function PlaceHeader() {
  const lat = useStore((s) => s.lat);
  const lon = useStore((s) => s.lon);
  const place = useStore((s) => s.place);
  const saved = useStore((s) => s.favorites.some((p) => samePlace(p, { lat, lon })));
  const comparing = useStore((s) => s.compare !== null);
  const known = place.kind !== "unknown";

  return (
    <header className="place">
      <div className="place-text">
        <h1 data-testid="place-name">{place.name}</h1>
        <p>
          {place.region && <span>{place.region} · </span>}
          <span data-testid="coords">{formatCoords(lat, lon)}</span>
        </p>
      </div>
      <div className="place-actions">
        <button
          type="button"
          className="icon-button"
          aria-pressed={saved}
          aria-label={saved ? "Remove from saved places" : "Save this place"}
          title={saved ? "Remove from saved places" : "Save this place"}
          disabled={!known}
          onClick={() => toggleFavorite(currentPlace())}
        >
          <Icon name="star" filled={saved} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={comparing}
          aria-label={comparing ? "Stop comparing" : "Compare with another place"}
          title={comparing ? "Stop comparing" : "Compare this place's time with another"}
          disabled={!known && !comparing}
          onClick={() => setCompare(comparing ? null : currentPlace())}
        >
          <Icon name="compare" />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Share a link to this view"
          title="Share a link to this view"
          onClick={() => void shareView()}
        >
          <Icon name="share" />
        </button>
      </div>
    </header>
  );
}
