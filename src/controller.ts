import majorCitiesJson from './data/majorCities.json';
import { angularDistanceDeg } from './geo/coords';
import { loadPlaceIndex, type Place, type PlaceIndex } from './geo/places';
import type { GlobeView } from './globe/camera';
import type { MarkerCity } from './globe/markers';
import type { GlobeScene, LightPoint } from './globe/scene';
import { saveSettings, useStore, type Settings } from './store';
import { formatHash, parseHash, type SharedView } from './urlState';
import { startCityWeather } from './weather/cityWeather';
import { ForecastLoader } from './weather/forecastLoader';
import { fetchForecast, type CityCurrent } from './weather/provider';

export const majorCities = majorCitiesJson as MarkerCity[];

const LIGHT_COUNT = 9000;
const PLACE_REFRESH_MS = 100;
/** A named destination keeps its name while the reticle stays this close. */
const NAMED_PLACE_DEGREES = 0.15;

const forecastLoader = new ForecastLoader(fetchForecast, (forecast) => {
  useStore.setState({ forecast });
});

let scene: GlobeScene | null = null;
let placeIndex: PlaceIndex | null = null;
let namedPlace: (Place & { lat: number; lon: number }) | null = null;
let lightPoints: LightPoint[] | null = null;
let cityWeather = new Map<MarkerCity, CityCurrent>();
let lastPlaceAt = 0;

function describe(lat: number, lon: number): Place {
  if (namedPlace && angularDistanceDeg(namedPlace, { lat, lon }) < NAMED_PLACE_DEGREES) {
    return { kind: namedPlace.kind, name: namedPlace.name, region: namedPlace.region };
  }
  return placeIndex?.describe(lat, lon) ?? { kind: 'unknown', name: 'Locating…', region: '' };
}

function pushCityWeather(): void {
  const { unit } = useStore.getState().settings;
  scene?.setCityWeather((city) => cityWeather.get(city) ?? null, unit);
}

function settle(lat: number, lon: number, distance: number): void {
  useStore.setState({ lat, lon, distance, moving: false, place: describe(lat, lon) });
  forecastLoader.select(lat, lon);
  history.replaceState(null, '', formatHash(lat, lon, distance));
}

export const globeCallbacks = {
  onMove({ lat, lon, distance }: GlobeView) {
    const now = performance.now();
    if (now - lastPlaceAt < PLACE_REFRESH_MS) return;
    lastPlaceAt = now;
    useStore.setState({ lat, lon, distance, moving: true, place: describe(lat, lon) });
  },
  onSettle({ lat, lon, distance }: GlobeView) {
    settle(lat, lon, distance);
  },
  onTapPoint(lat: number, lon: number) {
    goTo(lat, lon);
  },
  onTapCity(city: MarkerCity) {
    goToNamed(city.lat, city.lon, city.name, regionOf(city.country));
  },
};

function regionOf(code: string): string {
  try {
    return new Intl.DisplayNames(['en'], { type: 'region' }).of(code) ?? code;
  } catch {
    return code;
  }
}

/** Moves the view, or just the selection when there is no globe to move. */
export function goTo(lat: number, lon: number, distance?: number): void {
  if (scene) scene.flyTo(lat, lon, distance);
  else settle(lat, lon, useStore.getState().distance);
}

export function goToNamed(lat: number, lon: number, name: string, region: string): void {
  namedPlace = { kind: 'city', name, region, lat, lon };
  goTo(lat, lon, scene?.arrivalDistance);
}

export function goToMyLocation(): void {
  if (!('geolocation' in navigator)) {
    useStore.setState({ notice: 'Location is not available in this browser.' });
    return;
  }
  navigator.geolocation.getCurrentPosition(
    ({ coords }) => {
      useStore.setState({ notice: null });
      goTo(coords.latitude, coords.longitude, scene?.arrivalDistance);
    },
    () => useStore.setState({ notice: 'Could not get your location.' }),
    { maximumAge: 10 * 60_000, timeout: 10_000 },
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

export function getScene(): GlobeScene | null {
  return scene;
}

export function attachScene(next: GlobeScene | null): void {
  scene = next;
  if (next) {
    pushCityWeather();
    if (lightPoints) next.setLights(lightPoints);
  }
}

/** With no shared link, start at the viewer's longitude, estimated from their clock. */
export function initialView(): SharedView {
  const shared = parseHash(location.hash);
  if (shared) return shared;
  const offsetHours = -new Date().getTimezoneOffset() / 60;
  return { lat: 20, lon: Math.max(-180, Math.min(179, offsetHours * 15)) };
}

/** Starts background work once, returning a function that stops it. */
export function startApp(): () => void {
  const view = initialView();
  useStore.setState({ lat: view.lat, lon: view.lon });

  // Lazy-loaded: names and night lights fade in without delaying the globe.
  void loadPlaceIndex()
    .then(({ index, cities }) => {
      placeIndex = index;
      lightPoints = cities
        .slice(0, LIGHT_COUNT)
        .map(([, , lat, lon, pop]) => ({ lat, lon, pop }));
      scene?.setLights(lightPoints);
      const { lat, lon } = useStore.getState();
      useStore.setState({ place: describe(lat, lon) });
    })
    .catch((error: unknown) => {
      console.warn('Could not load place names', error);
      useStore.setState({ place: { kind: 'unknown', name: 'Unnamed place', region: '' } });
    });

  const stopCityWeather = startCityWeather(majorCities, (rows) => {
    cityWeather = new Map();
    majorCities.forEach((city, i) => {
      const row = rows[i];
      if (row) cityWeather.set(city, row);
    });
    pushCityWeather();
  });

  const refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') forecastLoader.refreshIfExpired();
  }, 60_000);

  const onHashChange = () => {
    const shared = parseHash(location.hash);
    if (shared) goTo(shared.lat, shared.lon, shared.distance);
  };
  window.addEventListener('hashchange', onHashChange);

  return () => {
    stopCityWeather();
    clearInterval(refreshTimer);
    window.removeEventListener('hashchange', onHashChange);
  };
}
