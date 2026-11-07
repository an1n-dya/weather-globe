const SOURCES = [
  ["https://open-meteo.com/", "Weather data by Open-Meteo"],
  ["https://www.geonames.org/", "GeoNames"],
  ["https://www.naturalearthdata.com/", "Natural Earth"],
  ["https://www.ncei.noaa.gov/products/etopo-global-relief-model", "NOAA ETOPO"],
  [
    "https://science.nasa.gov/earth/earth-observatory/blue-marble-next-generation/",
    "NASA Blue Marble",
  ],
  ["https://nsidc.org/data/g02135/versions/4", "NSIDC Sea Ice Index"],
] as const;

export function Credits() {
  return (
    <footer className="credits">
      {SOURCES.map(([href, text], i) => (
        <span key={href}>
          {i > 0 && " · "}
          <a href={href} target="_blank" rel="noreferrer">
            {text}
          </a>
        </span>
      ))}
    </footer>
  );
}
