import type { TempUnit, WindUnit } from "./ui/format";

export interface Settings {
  unit: TempUnit;
  hour12: boolean;
  wind: WindUnit;
}

const SETTINGS_KEY = "weather-globe.settings.v1";
const FAHRENHEIT_REGIONS = ["US", "BS", "BZ", "KY", "PW", "LR"];
/** Where road signs, and so most people, use miles per hour. */
const MPH_REGIONS = ["US", "GB", "LR", "MM", "BS", "BZ", "KY", "PW"];

/** Defaults follow the browser's language and region, e.g. en-US gets °F, mph and 12-hour time. */
export function defaultSettings(locale = navigator.language): Settings {
  const hour12 =
    new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 ?? false;
  const region = (() => {
    try {
      return new Intl.Locale(locale).maximize().region ?? "";
    } catch {
      return locale.split("-")[1]?.toUpperCase() ?? "";
    }
  })();
  return {
    hour12,
    unit: FAHRENHEIT_REGIONS.includes(region) ? "f" : "c",
    wind: MPH_REGIONS.includes(region) ? "mph" : "kmh",
  };
}

export function loadSettings(): Settings {
  const defaults = defaultSettings();
  try {
    const saved = JSON.parse(
      localStorage.getItem(SETTINGS_KEY) ?? "{}",
    ) as Partial<Settings> | null;
    return {
      unit: saved?.unit === "c" || saved?.unit === "f" ? saved.unit : defaults.unit,
      hour12: typeof saved?.hour12 === "boolean" ? saved.hour12 : defaults.hour12,
      wind:
        saved?.wind === "kmh" || saved?.wind === "mph" || saved?.wind === "ms"
          ? saved.wind
          : defaults.wind,
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
