import { useStore } from "../store";

export function Reticle() {
  const moving = useStore((s) => s.moving);
  return (
    <div className={`reticle${moving ? " is-moving" : ""}`}>
      <svg viewBox="0 0 48 48" aria-hidden="true">
        <circle cx="24" cy="24" r="11" className="reticle-shadow" />
        <path d="M24 3v9M24 36v9M3 24h9M36 24h9" className="reticle-shadow" />
        <circle cx="24" cy="24" r="11" />
        <path d="M24 3v9M24 36v9M3 24h9M36 24h9" />
        <circle cx="24" cy="24" r="1.8" className="reticle-dot" />
      </svg>
    </div>
  );
}
