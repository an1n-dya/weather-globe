import { create } from 'zustand';
import type { Place } from './geo/places';
import { snapToCell } from './weather/cache';
import { IDLE_FORECAST, type ForecastState } from './weather/forecastLoader';
import type { TempUnit } from './ui/format';

export interface Settings {
  unit: TempUnit;
  hour12: boolean;
}

const SETTINGS_KEY = 'weather-globe.settings.v1';

function defaultSettings(): Settings {
  const hour12 = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hour12 ?? false;
  const fahrenheitRegions = ['US', 'BS', 'BZ', 'KY', 'PW', 'LR'];
  const region = navigator.language.split('-')[1]?.toUpperCase() ?? '';
  return { hour12, unit: fahrenheitRegions.includes(region) ? 'f' : 'c' };
}

function loadSettings(): Settings {
  const defaults = defaultSettings();
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Partial<Settings>;
    return {
      unit: saved.unit === 'c' || saved.unit === 'f' ? saved.unit : defaults.unit,
      hour12: typeof saved.hour12 === 'boolean' ? saved.hour12 : defaults.hour12,
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(settings: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Without storage the choice simply lasts for this visit.
  }
}

export interface AppState {
  lat: number;
  lon: number;
  distance: number;
  moving: boolean;
  place: Place;
  forecast: ForecastState;
  settings: Settings;
  webglFailed: boolean;
  notice: string | null;
}

export const useStore = create<AppState>(() => ({
  lat: 20,
  lon: 0,
  distance: 3,
  moving: false,
  place: { kind: 'unknown', name: 'Locating…', region: '' },
  forecast: IDLE_FORECAST,
  settings: loadSettings(),
  webglFailed: false,
  notice: null,
}));

/** The forecast only counts when it belongs to the place under the reticle. */
export function forecastForSelection(state: AppState): ForecastState | null {
  const { forecast, lat, lon } = state;
  return forecast.key === snapToCell(lat, lon).key ? forecast : null;
}
