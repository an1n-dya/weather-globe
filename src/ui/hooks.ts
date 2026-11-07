import { useEffect, useState } from "react";

/** Re-renders on each new second, so clocks never skip or lag. */
export function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          schedule();
        },
        1000 - (Date.now() % 1000),
      );
    };
    schedule();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

/** Whether a media query matches, kept up to date. */
export function useMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

export const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
