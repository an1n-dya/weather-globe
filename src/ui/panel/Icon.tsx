/** Small line icons for buttons, drawn on a 24-unit grid with a 2-unit stroke. */
const PATHS = {
  star: "M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8-4.2-4.1 5.8-.8z",
  share: "M12 3.5v11M7.8 7.7L12 3.5l4.2 4.2M6 11.5H5v8h14v-8h-1",
  compare: "M4 8h13M14 5l3 3-3 3M20 16H7M10 13l-3 3 3 3",
  close: "M6 6l12 12M18 6L6 18",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  locate: "M12 2.5v4M12 17.5v4M2.5 12h4M17.5 12h4M18.5 12a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0z",
  home: "M4 11.5L12 4l8 7.5M6.5 9.5V20h11V9.5",
  search: "M17.5 11a6.5 6.5 0 1 1-13 0 6.5 6.5 0 0 1 13 0zM16 16l4.5 4.5",
  clock: "M12 7v5l3 2M20.5 12a8.5 8.5 0 1 1-17 0 8.5 8.5 0 0 1 17 0z",
  chevronLeft: "M14.5 6l-6 6 6 6",
  chevronRight: "M9.5 6l6 6-6 6",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, filled = false }: { name: IconName; filled?: boolean }) {
  return (
    <svg className={`icon${filled ? " is-filled" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
