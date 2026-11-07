import { updateSettings } from "../../controller";
import { useStore } from "../../store";

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<readonly [T, string, string?]>;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset className="segmented">
      <legend className="sr-only">{label}</legend>
      {options.map(([option, text, spoken]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          aria-label={spoken}
          onClick={() => onChange(option)}
        >
          {text}
        </button>
      ))}
    </fieldset>
  );
}

const TEMPERATURE_OPTIONS = [
  ["c", "°C"],
  ["f", "°F"],
] as const;

const CLOCK_OPTIONS = [
  ["12", "12h"],
  ["24", "24h"],
] as const;

const WIND_OPTIONS = [
  ["kmh", "km/h", "Kilometers per hour"],
  ["mph", "mph", "Miles per hour"],
  ["ms", "m/s", "Meters per second"],
] as const;

export function SettingsSection() {
  const settings = useStore((s) => s.settings);
  return (
    <section className="settings" aria-label="Units">
      <Segmented
        label="Temperature unit"
        value={settings.unit}
        options={TEMPERATURE_OPTIONS}
        onChange={(unit) => updateSettings({ unit })}
      />
      <Segmented
        label="Clock format"
        value={settings.hour12 ? "12" : "24"}
        options={CLOCK_OPTIONS}
        onChange={(value) => updateSettings({ hour12: value === "12" })}
      />
      <Segmented
        label="Wind speed unit"
        value={settings.wind}
        options={WIND_OPTIONS}
        onChange={(wind) => updateSettings({ wind })}
      />
    </section>
  );
}
