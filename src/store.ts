import { create } from "zustand";
import type { Place } from "./geo/places";
import { loadPlaceLists, type SavedPlace } from "./savedPlaces";
import { loadSettings, type Settings } from "./settings";
import { initialView } from "./urlState";
import { snapToCell } from "./weather/cache";
import { type ForecastState, IDLE_FORECAST } from "./weather/forecastLoader";

export interface AppState {
  lat: number;
  lon: number;
  distance: number;
  moving: boolean;
  place: Place;
  forecast: ForecastState;
  settings: Settings;
  /** The 3D globe could not start, so only search and the panel are available. */
  globeFailed: boolean;
  notice: string | null;
  /** Waiting for the browser to report the viewer's location. */
  locating: boolean;
  favorites: SavedPlace[];
  recents: SavedPlace[];
  /** A place pinned to compare its clock with the one under the reticle. */
  compare: SavedPlace | null;
  /** A short message that goes away by itself, such as "Link copied". */
  toast: string | null;
}

const start = initialView();

export const useStore = create<AppState>(() => ({
  lat: start.lat,
  lon: start.lon,
  distance: start.distance ?? 3,
  moving: false,
  place: { kind: "unknown", name: "Locating…", region: "" },
  forecast: IDLE_FORECAST,
  settings: loadSettings(),
  globeFailed: false,
  notice: null,
  locating: false,
  ...loadPlaceLists(),
  compare: null,
  toast: null,
}));

/** The forecast only counts when it belongs to the place under the reticle. */
export function forecastForSelection(state: AppState): ForecastState | null {
  const { forecast, lat, lon } = state;
  return forecast.key === snapToCell(lat, lon).key ? forecast : null;
}
