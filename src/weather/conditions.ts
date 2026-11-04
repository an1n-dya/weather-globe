/**
 * What the sky is doing at one place, as the globe draws it: every value is
 * 0 to 1. Derived from the WMO weather code, refined by measured cloud cover
 * and precipitation when the service reports them.
 */
export interface Sky {
  /** Cloud cover. */
  cloud: number;
  /** Precipitation intensity: 0.15 is drizzle, 1 a cloudburst. */
  precip: number;
  /** The share of precipitation falling as snow or ice. */
  snow: number;
  /** Lightning activity. */
  thunder: number;
  fog: number;
  hail: boolean;
}

interface CodeSky {
  cloud: number;
  precip?: number;
  snow?: number;
  thunder?: number;
  fog?: number;
  hail?: boolean;
}

const CODE_SKY: Readonly<Record<number, CodeSky>> = {
  0: { cloud: 0.03 },
  1: { cloud: 0.2 },
  2: { cloud: 0.5 },
  3: { cloud: 0.95 },
  45: { cloud: 0.85, fog: 1 },
  48: { cloud: 0.85, fog: 1, snow: 0.3 },
  51: { cloud: 0.9, precip: 0.15 },
  53: { cloud: 0.92, precip: 0.22 },
  55: { cloud: 0.95, precip: 0.3 },
  56: { cloud: 0.92, precip: 0.18, snow: 0.35 },
  57: { cloud: 0.95, precip: 0.3, snow: 0.35 },
  61: { cloud: 0.92, precip: 0.35 },
  63: { cloud: 0.95, precip: 0.6 },
  65: { cloud: 1, precip: 0.88 },
  66: { cloud: 0.95, precip: 0.4, snow: 0.45 },
  67: { cloud: 1, precip: 0.75, snow: 0.45 },
  71: { cloud: 0.92, precip: 0.3, snow: 1 },
  73: { cloud: 0.95, precip: 0.55, snow: 1 },
  75: { cloud: 1, precip: 0.85, snow: 1 },
  77: { cloud: 0.9, precip: 0.25, snow: 1 },
  80: { cloud: 0.75, precip: 0.4 },
  81: { cloud: 0.85, precip: 0.65 },
  82: { cloud: 0.95, precip: 1 },
  85: { cloud: 0.8, precip: 0.45, snow: 1 },
  86: { cloud: 0.92, precip: 0.8, snow: 1 },
  95: { cloud: 0.95, precip: 0.75, thunder: 0.7 },
  96: { cloud: 1, precip: 0.85, thunder: 0.9, hail: true },
  99: { cloud: 1, precip: 1, thunder: 1, hail: true },
};

const clamp01 = (value: number) => Math.max(0, Math.min(1, value));

export interface Measured {
  /** Percent, as reported. */
  cloudCover?: number | null;
  /** Millimetres over the reporting interval. */
  precipitation?: number | null;
  /** Air temperature in °C, which decides rain or snow when the code doesn't. */
  temp?: number | null;
}

export function skyFor(code: number, measured: Measured = {}): Sky {
  const base = CODE_SKY[code] ?? { cloud: 0.6 };
  const { cloudCover, precipitation, temp } = measured;
  // Rain gauges see drizzle the code may not mention, and the code can lag a downpour.
  const fromAmount =
    typeof precipitation === "number" && precipitation > 0 ? 1 - Math.exp(-precipitation / 1.6) : 0;
  const precip = clamp01(Math.max(base.precip ?? 0, fromAmount));
  const reported = typeof cloudCover === "number" ? clamp01(cloudCover / 100) : null;
  // A wet sky is never clear, whatever the cloud sensor says.
  const cloud = Math.max(reported ?? base.cloud, precip > 0 ? 0.7 + precip * 0.3 : 0);
  const snowByTemp = typeof temp === "number" ? clamp01((1 - temp) / 3) : 0;
  return {
    cloud,
    precip,
    snow: precip > 0 ? (base.snow ?? snowByTemp) : 0,
    thunder: base.thunder ?? 0,
    fog: base.fog ?? 0,
    hail: base.hail ?? false,
  };
}
