/** Placeholders the size of what's coming, so the panel doesn't jump when the weather lands. */
export function WeatherSkeleton() {
  return (
    <div className="skeleton-stack" aria-hidden="true">
      <div className="skeleton-block is-title" />
      <div className="skeleton-row">
        {Array.from({ length: 6 }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders.
          <div key={i} className="skeleton-block is-hour" />
        ))}
      </div>
      <div className="skeleton-block is-title" />
      {Array.from({ length: 4 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders.
        <div key={i} className="skeleton-block is-line" />
      ))}
    </div>
  );
}
