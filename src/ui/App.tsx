import { useEffect, useMemo, useRef, useState } from "react";
import {
  attachScene,
  globeCallbacks,
  goToMyLocation,
  majorCities,
  resetView,
  startApp,
} from "../controller";
import { earthFile } from "../globe/earthFile";
import type { GlobeScene, Insets } from "../globe/scene";
import { forecastForSelection, useStore } from "../store";
import { initialView } from "../urlState";
import { describeWeatherCode } from "../weather/wmo";
import { formatTemperature } from "./format";
import { useMedia } from "./hooks";
import { InfoPanel, type PanelLayout, type SheetState } from "./InfoPanel";
import { Icon } from "./panel/Icon";
import { Reticle } from "./Reticle";
import { SearchBox } from "./SearchBox";

/** Upright phones and tablets get a bottom sheet; anything wider or sideways, a side panel. */
const SHEET_LAYOUT_QUERY = "(orientation: portrait) and (max-width: 1023px)";
/** Below the search box. */
const SHEET_TOP_GAP = 72;
const SHEET_COLLAPSED = 206;
const SIDE_PANEL_WIDTH = 360;
const SIDE_PANEL_NARROW = 304;
const SIDE_MARGIN = 16;

interface Viewport {
  width: number;
  height: number;
  /** The safe area at the bottom, such as an iPhone's home bar. */
  safeBottom: number;
}

function readViewport(probe: HTMLElement | null): Viewport {
  return {
    width: window.innerWidth,
    height: window.innerHeight,
    safeBottom: probe ? Number.parseFloat(getComputedStyle(probe).paddingBottom) || 0 : 0,
  };
}

function useViewport(): Viewport {
  const [size, setSize] = useState(() => readViewport(null));
  useEffect(() => {
    // An element whose padding reports env(safe-area-inset-bottom) in pixels.
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;visibility:hidden;pointer-events:none;padding-bottom:env(safe-area-inset-bottom)";
    document.body.append(probe);
    const update = () => setSize(readViewport(probe));
    update();
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("resize", update);
      probe.remove();
    };
  }, []);
  return size;
}

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<GlobeScene | null>(null);
  const globeFailed = useStore((s) => s.globeFailed);
  const notice = useStore((s) => s.notice);
  const toast = useStore((s) => s.toast);
  const locating = useStore((s) => s.locating);
  const place = useStore((s) => s.place);
  const moving = useStore((s) => s.moving);
  const unit = useStore((s) => s.settings.unit);
  const forecast = useStore(forecastForSelection);
  const [announcement, setAnnouncement] = useState("");

  const sheetLayout = useMedia(SHEET_LAYOUT_QUERY);
  const layout: PanelLayout = sheetLayout ? "sheet" : "side";
  const [sheet, setSheet] = useState<SheetState>("collapsed");
  const viewport = useViewport();

  const heights = useMemo(() => {
    const full = Math.max(SHEET_COLLAPSED + 120, viewport.height - SHEET_TOP_GAP);
    const collapsed = SHEET_COLLAPSED + viewport.safeBottom;
    const half = Math.max(collapsed + 80, Math.min(full, Math.round(viewport.height * 0.56)));
    return { collapsed, half, full };
  }, [viewport.height, viewport.safeBottom]);

  // The globe sits in what the panel or sheet leaves free, and moves up as the sheet rises.
  const insets = useMemo<Insets>(() => {
    if (layout === "sheet") {
      const covered = sheet === "collapsed" ? heights.collapsed : heights.half;
      return { top: 64, right: 0, bottom: covered };
    }
    const width = viewport.height < 500 ? SIDE_PANEL_NARROW : SIDE_PANEL_WIDTH;
    return { top: 0, right: width + SIDE_MARGIN * 2, bottom: 0 };
  }, [layout, sheet, heights, viewport.height]);
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    sceneRef.current?.setInsets(insets);
  }, [insets]);

  useEffect(() => startApp(), []);

  // One polite announcement once the view settles, with the weather when it's in.
  useEffect(() => {
    if (moving || place.kind === "unknown") return;
    const where = [place.name, place.region].filter(Boolean).join(", ");
    const data = forecast?.status === "ready" ? forecast.data : null;
    setAnnouncement(
      data
        ? `${where}. ${formatTemperature(data.current.temp, unit)}, ${describeWeatherCode(data.current.code).label.toLowerCase()}.`
        : where,
    );
  }, [moving, place, forecast, unit]);

  useEffect(() => {
    const stage = stageRef.current;
    const markerLayer = markerRef.current;
    if (!stage || !markerLayer) return;

    let cancelled = false;
    let teardown: (() => void) | undefined;

    // The globe's data downloads while three.js does. Errors surface when the scene asks for it.
    if (typeof WebGL2RenderingContext !== "undefined") earthFile().catch(() => {});

    // Loaded separately so the time and weather appear before three.js arrives.
    import("../globe/scene")
      .then(({ GlobeScene }) => {
        if (cancelled) return;
        // Where the view is now (a search may already have moved it), at the shared
        // link's zoom if it had one; otherwise the globe is fitted to the screen.
        const { lat, lon } = useStore.getState();
        const scene = new GlobeScene({
          container: stage,
          markerLayer,
          cities: majorCities,
          initial: { lat, lon, distance: initialView().distance },
          insets: insetsRef.current,
          callbacks: globeCallbacks,
          obstacles: () => [...document.querySelectorAll(".search, .map-controls")],
        });
        sceneRef.current = scene;
        attachScene(scene);
        teardown = () => {
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
    <main
      className="app"
      data-layout={layout}
      data-sheet={layout === "sheet" ? sheet : undefined}
      style={
        {
          "--sheet-collapsed": `${heights.collapsed}px`,
          "--sheet-half": `${heights.half}px`,
          "--sheet-full": `${heights.full}px`,
          "--sheet-covered": `${layout === "sheet" ? insets.bottom : 0}px`,
        } as React.CSSProperties
      }
    >
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
        <nav className="map-controls" aria-label="Globe controls">
          <div className="control-group">
            <button
              type="button"
              aria-label="Zoom in"
              title="Zoom in (+)"
              onClick={() => sceneRef.current?.zoomBy(0.6)}
            >
              <Icon name="plus" />
            </button>
            <button
              type="button"
              aria-label="Zoom out"
              title="Zoom out (−)"
              onClick={() => sceneRef.current?.zoomBy(1.6)}
            >
              <Icon name="minus" />
            </button>
          </div>
          <button
            type="button"
            className="control-single"
            aria-label="Show the whole globe"
            title="Show the whole globe"
            onClick={resetView}
          >
            <Icon name="home" />
          </button>
          <button
            type="button"
            className={`control-single${locating ? " is-busy" : ""}`}
            aria-label="Go to my location"
            title="Go to my location"
            aria-busy={locating}
            onClick={goToMyLocation}
          >
            <Icon name="locate" />
          </button>
        </nav>
      )}

      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button
            type="button"
            className="icon-button is-small"
            aria-label="Dismiss"
            onClick={() => useStore.setState({ notice: null })}
          >
            <Icon name="close" />
          </button>
        </div>
      )}

      <InfoPanel layout={layout} sheet={sheet} onSheet={setSheet} heights={heights} />

      <div className="toast-region" role="status" aria-live="polite">
        {toast && <div className="toast">{toast}</div>}
      </div>
      <div className="sr-only" aria-live="polite">
        {announcement}
      </div>
    </main>
  );
}
