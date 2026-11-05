import majorCitiesJson from "./data/majorCities.json";
import { angularDistanceDeg, clampViewLat } from "./geo/coords";
import { countryName, loadPlaceIndex, type Place, type PlaceIndex } from "./geo/places";
import { isSunUp } from "./geo/sun";
import type { GlobeView } from "./globe/camera";
import type { MarkerCity } from "./globe/markers";
import type { GlobeScene } from "./globe/scene";
import { forecastForSelection, type Settings, saveSettings, useStore } from "./store";
import { formatTemperature } from "./ui/format";
import { iconSrc } from "./ui/icons";
import { formatHash, parseHash } from "./urlState";
import { skyFor } from "./weather/conditions";
import type { SkySample } from "./weather/field";
import { ForecastLoader } from "./weather/forecastLoader";
import { fetchForecast, type SkyCurrent } from "./weather/provider";
import { skyPoints } from "./weather/skyPoints";
import { startSkyWeather } from "./weather/skyWeather";
import { describeWeatherCode } from "./weather/wmo";

export const majorCities = majorCitiesJson as MarkerCity[];
/** The cities come first, so their rows line up with the markers. */
const samplePoints = [...majorCities, ...skyPoints(majorCities)];

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
let cityWeather = new Map<MarkerCity, SkyCurrent>();
let skySamples: SkySample[] = [];
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

/** The selected place's own forecast shapes the sky right around it. */
function pushLocalSky(): void {
  const forecast = forecastForSelection(useStore.getState());
  const data = forecast?.data;
  if (!scene || !forecast?.key || !data) return;
  const [lat = 0, lon = 0] = forecast.key.split(",").map(Number);
  const { current } = data;
  scene.setLocalSky({
    lat,
    lon,
    sky: skyFor(current.code, {
      cloudCover: current.cloudCover,
      precipitation: current.precipitation,
      temp: current.temp,
    }),
    windDirection: current.windDirection,
    wind: current.wind,
  });
}

function settle(lat: number, lon: number, distance: number): void {
  useStore.setState({ lat, lon, distance, moving: false, place: placeAt(lat, lon) });
  forecastLoader.select(lat, lon);
  history.replaceState(null, "", formatHash(lat, lon, distance));
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
  // The camera can't reach the exact poles, so compare against where it will stop.
  namedPlace = { kind: "city", name, region, lat: clampViewLat(lat), lon };
  goTo(lat, lon, scene?.arrivalDistance);
}

export function goToMyLocation(): void {
  if (!("geolocation" in navigator)) {
    useStore.setState({ notice: "Location is not available in this browser." });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      useStore.setState({ notice: null });
      goTo(coords.latitude, coords.longitude, scene?.arrivalDistance);
    },
    () => useStore.setState({ notice: "Could not get your location." }),
    { maximumAge: 10 * 60_000, timeout: 10_000 },
  );
}

export function updateSettings(change: Partial<Settings>): void {
  const settings = { ...useStore.getState().settings, ...change };
  useStore.setState({ settings });
  saveSettings(settings);
  pushCityWeather();
  scene?.setWeatherVisible(settings.weather);
}

export function retryForecast(): void {
  forecastLoader.retryNow();
}

export function attachScene(next: GlobeScene | null): void {
  scene = next;
  if (next) {
    next.setWeatherVisible(useStore.getState().settings.weather);
    pushCityWeather();
    if (skySamples.length) next.setSkySamples(skySamples);
    pushLocalSky();
  }
}

/** Starts background work, returning a function that stops it. */
export function startApp(): () => void {
  let stopped = false;

  // The time and weather don't need to wait for the globe, or for WebGL at all.
  const { lat, lon } = useStore.getState();
  forecastLoader.select(lat, lon);

  // Lazy-loaded: names arrive without delaying anything else.
  void loadPlaceIndex()
    .then(({ index }) => {
      if (stopped) return;
      placeIndex = index;
      const current = useStore.getState();
      useStore.setState({ place: placeAt(current.lat, current.lon) });
    })
    .catch((error: unknown) => {
      console.warn("Could not load place names", error);
      if (!stopped) {
        useStore.setState({ place: { kind: "unknown", name: "Unnamed place", region: "" } });
      }
    });

  const stopSkyWeather = startSkyWeather(samplePoints, (rows) => {
    cityWeather = new Map();
    majorCities.forEach((city, i) => {
      const row = rows[i];
      if (row) cityWeather.set(city, row);
    });
    skySamples = samplePoints.flatMap((point, i) => {
      const row = rows[i];
      if (!row) return [];
      const sky = skyFor(row.code, {
        cloudCover: row.cloudCover,
        precipitation: row.precipitation,
        temp: row.temp,
      });
      return [{ lat: point.lat, lon: point.lon, sky }];
    });
    pushCityWeather();
    scene?.setSkySamples(skySamples);
  });

  // The selected place's forecast arriving, or changing, reshapes its sky.
  const stopLocalSky = useStore.subscribe((state, previous) => {
    if (state.forecast !== previous.forecast && state.forecast.status === "ready") pushLocalSky();
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
    stopSkyWeather();
    stopLocalSky();
    clearInterval(refreshTimer);
    window.removeEventListener("hashchange", onHashChange);
    window.removeEventListener("online", retryForecast);
    document.removeEventListener("visibilitychange", refreshIfVisible);
  };
}
