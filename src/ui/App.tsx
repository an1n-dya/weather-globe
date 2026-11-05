import { useEffect, useRef, useState } from "react";
import {
  attachScene,
  globeCallbacks,
  goToMyLocation,
  majorCities,
  startApp,
  updateSettings,
} from "../controller";
import type { GlobeScene, Insets } from "../globe/scene";
import { useStore } from "../store";
import { initialView } from "../urlState";
import { InfoPanel } from "./InfoPanel";
import { Reticle } from "./Reticle";
import { SearchBox } from "./SearchBox";

/** Sideways phones keep the side panel, as a bottom sheet would leave no room for the globe. */
const SHEET_LAYOUT_QUERY = "(max-width: 719px) and (orientation: portrait)";

function currentInsets(): Insets {
  // These sizes match the panel and sheet in styles.css.
  return matchMedia(SHEET_LAYOUT_QUERY).matches
    ? { top: 64, right: 0, bottom: 214 }
    : { top: 0, right: 384, bottom: 0 };
}

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const globeFailed = useStore((s) => s.globeFailed);
  const notice = useStore((s) => s.notice);
  const place = useStore((s) => s.place);
  const moving = useStore((s) => s.moving);
  const weatherShown = useStore((s) => s.settings.weather);
  const [announcement, setAnnouncement] = useState("");

  useEffect(() => startApp(), []);

  useEffect(() => {
    if (!moving && place.kind !== "unknown") {
      setAnnouncement([place.name, place.region].filter(Boolean).join(", "));
    }
  }, [moving, place]);

  useEffect(() => {
    const stage = stageRef.current;
    const markerLayer = markerRef.current;
    if (!stage || !markerLayer) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    // Loaded separately so the time and weather appear before three.js arrives.
    import("../globe/scene")
      .then(({ GlobeScene }) => {
        if (cancelled) return;
        const scene = new GlobeScene({
          container: stage,
          markerLayer,
          cities: majorCities,
          initial: initialView(),
          insets: currentInsets(),
          callbacks: globeCallbacks,
          obstacles: () => [...document.querySelectorAll(".search, .map-controls")],
        });
        sceneRef.current = scene;
        attachScene(scene);

        const media = matchMedia(SHEET_LAYOUT_QUERY);
        const onLayoutChange = () => scene.setInsets(currentInsets());
        media.addEventListener("change", onLayoutChange);

        teardown = () => {
          media.removeEventListener("change", onLayoutChange);
          attachScene(null);
          sceneRef.current = null;
          scene.dispose();
        };
      })
      .catch((error: unknown) => {
        console.warn("The globe could not start", error);
        if (!cancelled) useStore.setState({ globeFailed: true });
      });

    return () => {
      cancelled = true;
      teardown?.();
    };
  }, []);

  return (
    <main className="app">
      <div ref={stageRef} className="stage" data-testid="stage">
        <div ref={markerRef} className="marker-layer" aria-hidden="true" />
        {!globeFailed && <Reticle />}
      </div>

      {globeFailed && (
        <div className="webgl-notice">
          <h2>The 3D globe couldn't start</h2>
          <p>
            This browser or device may have WebGL turned off. You can still search for any place to
            see its time and weather.
          </p>
        </div>
      )}

      <SearchBox />

      {!globeFailed && (
        <div className="map-controls">
          <button
            type="button"
            aria-label="Zoom in"
            title="Zoom in"
            onClick={() => sceneRef.current?.zoomBy(0.65)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Zoom out"
            title="Zoom out"
            onClick={() => sceneRef.current?.zoomBy(1.5)}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 12h14" />
            </svg>
          </button>
          <button
            type="button"
            className="layer-toggle"
            aria-label="Clouds and rain"
            aria-pressed={weatherShown}
            title={weatherShown ? "Hide clouds and rain" : "Show clouds and rain"}
            onClick={() => updateSettings({ weather: !weatherShown })}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M7.5 17h9a3.8 3.8 0 0 0 .6-7.5 5.2 5.2 0 0 0-9.9-1A4.2 4.2 0 0 0 7.5 17z" />
              <path d="M9 20l-.8 1.6M13 20l-.8 1.6" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Go to my location"
            title="Go to my location"
            onClick={goToMyLocation}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="6.5" />
              <path d="M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4" />
            </svg>
          </button>
        </div>
      )}

      {notice && (
        <div className="notice" role="status">
          {notice}
          <button
            type="button"
            aria-label="Dismiss"
            onClick={() => useStore.setState({ notice: null })}
          >
            ×
          </button>
        </div>
      )}

      <InfoPanel />
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </main>
  );
}
