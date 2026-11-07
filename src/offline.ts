/** The files the service worker keeps as they're used, rather than at install. Matches vite.config.ts. */
const KEPT_AS_USED = /\/data\/[\w-]+\.bin$|\/assets\/scene-[\w-]+\.js$/;

/**
 * Makes sure the service worker keeps the globe and map data for offline use.
 * On a first visit the page usually fetches them before the worker takes over,
 * so they never pass through it. Fetching each one again once it has taken
 * over stores a copy, usually straight from the browser's HTTP cache.
 */
export function keepForOffline(): void {
  if (
    !("serviceWorker" in navigator) ||
    typeof PerformanceObserver === "undefined" ||
    !PerformanceObserver.supportedEntryTypes?.includes("resource")
  ) {
    return;
  }
  const missed = new Set<string>();
  const kept = new Set<string>();
  const flush = () => {
    if (!navigator.serviceWorker.controller) return;
    for (const url of missed) {
      missed.delete(url);
      kept.add(url);
      fetch(url).catch(() => kept.delete(url));
    }
  };
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
      // A zero workerStart means the worker wasn't involved, so it kept no copy.
      const path = new URL(entry.name).pathname;
      if (entry.workerStart === 0 && KEPT_AS_USED.test(path) && !kept.has(entry.name)) {
        missed.add(entry.name);
      }
    }
    flush();
  }).observe({ type: "resource", buffered: true });
  navigator.serviceWorker.addEventListener("controllerchange", flush);
}
