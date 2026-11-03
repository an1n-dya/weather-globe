import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  attachScene,
  getScene,
  globeCallbacks,
  goToMyLocation,
  initialView,
  majorCities,
  startApp,
} from '../controller';
import { GlobeScene, type Insets } from '../globe/scene';
import { useStore } from '../store';
import { InfoPanel } from './InfoPanel';
import { Reticle } from './Reticle';
import { SearchBox } from './SearchBox';

const PHONE_QUERY = '(max-width: 719px)';

function currentInsets(): Insets {
  return matchMedia(PHONE_QUERY).matches
    ? { top: 64, right: 0, bottom: 214 }
    : { top: 0, right: 384, bottom: 0 };
}

export function App() {
  const stageRef = useRef<HTMLDivElement>(null);
  const markerRef = useRef<HTMLDivElement>(null);
  const webglFailed = useStore((s) => s.webglFailed);
  const notice = useStore((s) => s.notice);
  const place = useStore((s) => s.place);
  const moving = useStore((s) => s.moving);
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => startApp(), []);

  useEffect(() => {
    if (!moving && place.kind !== 'unknown') {
      setAnnouncement([place.name, place.region].filter(Boolean).join(', '));
    }
  }, [moving, place]);

  useEffect(() => {
    const stage = stageRef.current;
    const markerLayer = markerRef.current;
    if (!stage || !markerLayer) return;

    let scene: GlobeScene;
    try {
      scene = new GlobeScene(stage, markerLayer, majorCities, initialView(), currentInsets(), globeCallbacks);
    } catch (error) {
      console.warn('WebGL is unavailable', error);
      useStore.setState({ webglFailed: true });
      return;
    }
    attachScene(scene);

    const media = matchMedia(PHONE_QUERY);
    const onLayoutChange = () => scene.setInsets(currentInsets());
    media.addEventListener('change', onLayoutChange);

    return () => {
      media.removeEventListener('change', onLayoutChange);
      attachScene(null);
      scene.dispose();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    const scene = getScene();
    if (!scene) return;
    const actions: Record<string, () => void> = {
      ArrowUp: () => scene.nudge(1, 0),
      ArrowDown: () => scene.nudge(-1, 0),
      ArrowLeft: () => scene.nudge(0, -1),
      ArrowRight: () => scene.nudge(0, 1),
      '+': () => scene.zoomBy(0.72),
      '=': () => scene.zoomBy(0.72),
      '-': () => scene.zoomBy(1.38),
    };
    const action = actions[event.key];
    if (action) {
      event.preventDefault();
      action();
    }
  };

  return (
    <main className="app">
      <div
        ref={stageRef}
        className="stage"
        data-testid="stage"
        tabIndex={0}
        role="application"
        aria-label="Globe. Use the arrow keys to rotate and plus or minus to zoom."
        onKeyDown={onKeyDown}
      >
        <div ref={markerRef} className="marker-layer" aria-hidden="true" />
        {!webglFailed && <Reticle />}
      </div>

      {webglFailed && (
        <div className="webgl-notice">
          <h2>The 3D globe can't run here</h2>
          <p>This browser or device has WebGL turned off. You can still search for any place to see its time and weather.</p>
        </div>
      )}

      <SearchBox />

      {!webglFailed && (
        <div className="map-controls">
          <button type="button" aria-label="Zoom in" title="Zoom in" onClick={() => getScene()?.zoomBy(0.65)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>
          </button>
          <button type="button" aria-label="Zoom out" title="Zoom out" onClick={() => getScene()?.zoomBy(1.5)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /></svg>
          </button>
          <button type="button" aria-label="Go to my location" title="Go to my location" onClick={goToMyLocation}>
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
          <button type="button" aria-label="Dismiss" onClick={() => useStore.setState({ notice: null })}>×</button>
        </div>
      )}

      <InfoPanel />
      <div className="sr-only" aria-live="polite">{announcement}</div>
    </main>
  );
}
