/** Never wait longer than this for the first paint, as in a page opened in the background. */
const FIRST_PAINT_WAIT_MS = 3000;

let painted: Promise<void> | null = null;

/**
 * Resolves once the first content is on screen, so heavy work such as large
 * downloads or starting WebGL never holds it up. The browser reports that
 * paint once it is shown; where it doesn't, the second frame is a close stand-in.
 */
export function afterFirstPaint(): Promise<void> {
  painted ??= new Promise((resolve) => {
    let observer: PerformanceObserver | null = null;
    const done = () => {
      observer?.disconnect();
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, FIRST_PAINT_WAIT_MS);
    if (
      typeof PerformanceObserver !== "undefined" &&
      PerformanceObserver.supportedEntryTypes?.includes("paint")
    ) {
      observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName("first-contentful-paint").length) done();
      });
      observer.observe({ type: "paint", buffered: true });
    } else {
      requestAnimationFrame(() => requestAnimationFrame(done));
    }
  });
  return painted;
}
