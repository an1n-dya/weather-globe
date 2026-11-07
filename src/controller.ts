import majorCitiesJson from "./data/majorCities.json";
import { afterFirstPaint } from "./firstPaint";
import { angularDistanceDeg, clampViewLat } from "./geo/coords";
import { countryName, loadPlaceIndex, type Place, type PlaceIndex } from "./geo/places";
import { isSunUp } from "./geo/sun";
import type { GlobeView } from "./globe/camera";
import type { MarkerCity } from "./globe/markers";
import type { GlobeScene, LightPoint } from "./globe/scene";
import {
  addToFront,
  MAX_FAVORITES,
  MAX_RECENTS,
  type SavedPlace,
  samePlace,
  savePlaceLists,
} from "./savedPlaces";
import { type Settings, saveSettings } from "./settings";
import { useStore } from "./store";
import { formatTemperature } from "./ui/format";
import { iconSrc } from "./ui/icons";
import { formatHash, parseHash, replaceHash } from "./urlState";
import { startCityWeather } from "./weather/cityWeather";
import { ForecastLoader } from "./weather/forecastLoader";
import { type CityCurrent, fetchForecast } from "./weather/provider";
import { describeWeatherCode } from "./weather/wmo";

export const majorCities = majorCitiesJson as MarkerCity[];

const LIGHT_COUNT = 9000;
const PLACE_REFRESH_MS = 100;
const BACKGROUND_REFRESH_MS = 60_000;
/** A named destination keeps its name while the reticle stays this close. */
const NAMED_PLACE_DEGREES = 0.15;
const UNKNOWN_PLACE: Place = { kind: "unknown", name: "Locating…", region: "" };

const forecastLoader = new ForecastLoader(fetchForecast, (forecast) => {
  useStore.setState({ forecast });
});

let scene: GlobeScene | null = null;
let placeIndex: PlaceIndex | null = null;
let namedPlace: (Place & { lat: number; lon: number }) | null = null;
let lightPoints: LightPoint[] | null = null;
let cityWeather = new Map<MarkerCity, CityCurrent>();
let lastPlaceAt = 0;

function placeAt(lat: number, lon: number): Place {
  if (namedPlace && angularDistanceDeg(namedPlace, { lat, lon }) < NAMED_PLACE_DEGREES) {
    return { kind: namedPlace.kind, name: namedPlace.name, region: namedPlace.region };
  }
  return placeIndex?.placeAt(lat, lon) ?? UNKNOWN_PLACE;
}

/** Day or night comes from the sun's position, so icons always agree with the terminator. */
function pushCityWeather(): void {
  const { unit } = useStore.getState().settings;
  const now = new Date();
  scene?.setCityWeather((city) => {
    const current = cityWeather.get(city);
    if (!current) return null;
    const { icon } = describeWeatherCode(current.code);
    return {
      iconSrc: iconSrc(icon, isSunUp(city.lat, city.lon, now)),
      temperature: formatTemperature(current.temp, unit),
    };
  });
}

function settle(lat: number, lon: number, distance: number): void {
  useStore.setState({ lat, lon, distance, moving: false, place: placeAt(lat, lon) });
  forecastLoader.select(lat, lon);
  replaceHash(formatHash(lat, lon, distance));
}

export const globeCallbacks = {
  onMove({ lat, lon, distance }: GlobeView) {
    const now = performance.now();
    if (now - lastPlaceAt < PLACE_REFRESH_MS) return;
    lastPlaceAt = now;
    useStore.setState({ lat, lon, distance, moving: true, place: placeAt(lat, lon) });
  },
  onSettle({ lat, lon, distance }: GlobeView) {
    settle(lat, lon, distance);
  },
  onTapPoint(lat: number, lon: number) {
    goTo(lat, lon);
  },
  onTapCity(city: MarkerCity) {
    goToNamed(city.lat, city.lon, city.name, countryName(city.country));
  },
};

/** Moves the view, or just the selection while there is no globe to move. */
function goTo(lat: number, lon: number, distance?: number): void {
  if (scene) scene.flyTo(lat, lon, distance);
  else settle(lat, lon, distance ?? useStore.getState().distance);
}

export function goToNamed(lat: number, lon: number, name: string, region: string): void {
  // A saved spot at sea stays at sea, which decides how its time zone is found.
  const kind = placeIndex?.placeAt(lat, lon).kind === "ocean" ? "ocean" : "city";
  // The camera can't reach the exact poles, so compare against where it will stop.
  namedPlace = { kind, name, region, lat: clampViewLat(lat), lon };
  goTo(lat, lon, scene?.arrivalDistance);
  rememberRecent({ name, region, lat, lon });
}

function storeLists(change: Partial<{ favorites: SavedPlace[]; recents: SavedPlace[] }>): void {
  useStore.setState(change);
  const { favorites, recents } = useStore.getState();
  savePlaceLists({ favorites, recents });
}

function rememberRecent(place: SavedPlace): void {
  storeLists({ recents: addToFront(useStore.getState().recents, place, MAX_RECENTS) });
}

export function forgetRecent(place: SavedPlace): void {
  storeLists({ recents: useStore.getState().recents.filter((p) => !samePlace(p, place)) });
}

/** The place under the reticle, as something that can be saved or compared. */
export function currentPlace(): SavedPlace {
  const { lat, lon, place } = useStore.getState();
  return { name: place.name, region: place.region, lat, lon };
}

export function isFavorite(place: { lat: number; lon: number }): boolean {
  return useStore.getState().favorites.some((p) => samePlace(p, place));
}

export function toggleFavorite(place: SavedPlace): void {
  const { favorites } = useStore.getState();
  const saved = favorites.some((p) => samePlace(p, place));
  storeLists({
    favorites: saved
      ? favorites.filter((p) => !samePlace(p, place))
      : addToFront(favorites, place, MAX_FAVORITES),
  });
  showToast(saved ? `Removed ${place.name} from saved places` : `Saved ${place.name}`);
}

export function goToSaved(place: SavedPlace): void {
  goToNamed(place.lat, place.lon, place.name, place.region);
}

export function setCompare(place: SavedPlace | null): void {
  useStore.setState({ compare: place });
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;

export function showToast(text: string): void {
  clearTimeout(toastTimer);
  useStore.setState({ toast: text });
  toastTimer = setTimeout(() => useStore.setState({ toast: null }), 2600);
}

/** Shares a link to this view: the system share sheet on phones, the clipboard elsewhere. */
export async function shareView(): Promise<void> {
  const { lat, lon, distance, place } = useStore.getState();
  const url = new URL(location.href);
  url.hash = formatHash(lat, lon, distance);
  const title = [place.name, place.region].filter(Boolean).join(", ");
  const touch = matchMedia("(pointer: coarse)").matches;
  if (touch && typeof navigator.share === "function") {
    try {
      await navigator.share({ title: `${title} · Weather Globe`, url: url.href });
      return;
    } catch (error) {
      // Closing the share sheet isn't a failure worth mentioning.
      if (error instanceof DOMException && error.name === "AbortError") return;
    }
  }
  try {
    await navigator.clipboard.writeText(url.href);
    showToast("Link copied");
  } catch {
    showToast("Couldn't copy the link. It's in the address bar.");
  }
}

/** Back out to the whole globe, keeping roughly the same side of the world in view. */
export function resetView(): void {
  const { lat, lon } = useStore.getState();
  namedPlace = null;
  if (scene) scene.resetView(Math.max(-35, Math.min(35, lat)), lon);
}

/** What to tell someone whose location couldn't be found, by the reason given. */
export function locationErrorText(code: number): string {
  switch (code) {
    case 1:
      return "Location access is turned off for this site. Allow it in your browser's settings to use this.";
    case 3:
      return "Finding your location took too long. Try again in a moment.";
    default:
      return "Your location isn't available right now.";
  }
}

export function goToMyLocation(): void {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    useStore.setState({ notice: "Location is not available in this browser." });
    return;
  }
  useStore.setState({ notice: "Finding your location…", locating: true });
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      useStore.setState({ notice: null, locating: false });
      namedPlace = null;
      goTo(coords.latitude, coords.longitude, scene?.arrivalDistance);
      showToast("Showing your location");
    },
    (error) => useStore.setState({ notice: locationErrorText(error.code), locating: false }),
    { maximumAge: 10 * 60_000, timeout: 12_000 },
  );
}

export function updateSettings(change: Partial<Settings>): void {
  const settings = { ...useStore.getState().settings, ...change };
  useStore.setState({ settings });
  saveSettings(settings);
  pushCityWeather();
}

export function retryForecast(): void {
  forecastLoader.retryNow();
}

export function attachScene(next: GlobeScene | null): void {
  scene = next;
  if (next) {
    pushCityWeather();
    if (lightPoints) next.setLights(lightPoints);
  }
}

/** Starts background work, returning a function that stops it. */
export function startApp(): () => void {
  let stopped = false;

  // The time and weather don't need to wait for the globe, or for WebGL at all.
  const { lat, lon } = useStore.getState();
  forecastLoader.select(lat, lon);

  // Names and night lights download once the first paint is on screen.
  void afterFirstPaint()
    .then(loadPlaceIndex)
    .then(({ index, cities }) => {
      if (stopped) return;
      placeIndex = index;
      lightPoints = cities.slice(0, LIGHT_COUNT).map(([, , lat, lon, pop]) => ({ lat, lon, pop }));
      scene?.setLights(lightPoints);
      const current = useStore.getState();
      useStore.setState({ place: placeAt(current.lat, current.lon) });
    })
    .catch((error: unknown) => {
      console.warn("Could not load place names", error);
      if (!stopped) {
        useStore.setState({ place: { kind: "unknown", name: "Unnamed place", region: "" } });
      }
    });

  const stopCityWeather = startCityWeather(majorCities, (rows) => {
    cityWeather = new Map();
    majorCities.forEach((city, i) => {
      const row = rows[i];
      if (row) cityWeather.set(city, row);
    });
    pushCityWeather();
  });

  const refreshIfVisible = () => {
    if (document.visibilityState === "visible") forecastLoader.refreshIfExpired();
  };
  const refreshTimer = setInterval(() => {
    refreshIfVisible();
    pushCityWeather();
  }, BACKGROUND_REFRESH_MS);

  const onHashChange = () => {
    const shared = parseHash(location.hash);
    if (shared) goTo(shared.lat, shared.lon, shared.distance);
  };
  window.addEventListener("hashchange", onHashChange);
  window.addEventListener("online", retryForecast);
  document.addEventListener("visibilitychange", refreshIfVisible);

  return () => {
    stopped = true;
    stopCityWeather();
    clearInterval(refreshTimer);
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("online", retryForecast);
    document.removeEventListener("visibilitychange", refreshIfVisible);
  };
}
