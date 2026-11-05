/** After this long without input, or while the window is in the background, the globe paces down. */
export const IDLE_AFTER_MS = 60_000;

export interface PaceState {
  /** Ambient animation is allowed: not prefers-reduced-motion. */
  motion: boolean;
  /** Rendering without a GPU, where every frame costs the CPU. */
  software: boolean;
  /** No input for a while, or the window isn't focused. */
  idle: boolean;
  /** The camera moved, a fade is running, or the weather is changing. */
  busy: boolean;
  /** Rain or snow is falling close up, which looks choppy below about 20 fps. */
  falling: boolean;
}

/**
 * Milliseconds to leave between frames when nothing forces one, or Infinity
 * to draw only on change. Cloud drift is slow enough to look smooth at 30 fps,
 * and still alive at 10; falling rain needs more.
 */
export function frameInterval({ motion, software, idle, busy, falling }: PaceState): number {
  if (!motion) return Number.POSITIVE_INFINITY;
  if (busy && !idle) return 0;
  if (software) return idle ? 250 : 125;
  if (falling) return idle ? 50 : 0;
  if (busy) return 1000 / 30;
  return idle ? 100 : 1000 / 30;
}
