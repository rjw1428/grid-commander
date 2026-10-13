import { useShallow } from "zustand/react/shallow";
import { selectCounts, useFleet } from "../store/useFleet.js";

export function Brand() {
  return (
    <div className="brand">
      <svg viewBox="0 0 32 32" aria-hidden="true">
        <polygon points="16,2 28,9 28,23 16,30 4,23 4,9" fill="none" stroke="#d4a73a" strokeWidth="2" />
        <polygon points="16,9 18.4,14.2 24,14.8 19.8,18.6 21,24 16,21.2 11,24 12.2,18.6 8,14.8 13.6,14.2" fill="#f2d27a" />
      </svg>
      Hex Command
    </div>
  );
}

export function ConnectionPill() {
  const connection = useFleet((s) => s.connection);
  const label = connection === "live" ? "live" : connection === "connecting" ? "connecting" : "offline";
  return (
    <span className={`pill ${connection}`} role="status" aria-live="polite">
      <span className="dot" />
      {label}
    </span>
  );
}

export function Header({ onLegend, legendOpen }: { onLegend: () => void; legendOpen: boolean }) {
  const counts = useFleet(useShallow(selectCounts));
  const server = useFleet((s) => s.server);
  return (
    <header className="header">
      <Brand />
      <div className="counters" aria-label="fleet counters">
        <span className="counter">
          <b>{counts.units}</b>units
        </span>
        <span className="counter">
          <b>{counts.working}</b>working
        </span>
        <span className={`counter${counts.waiting ? " hot" : ""}`}>
          <b>{counts.waiting}</b>awaiting input
        </span>
        <span className="counter">
          <b>{counts.teams}</b>teams
        </span>
        {server && (
          <span className="counter">
            <b>
              {server.runningUnits}/{server.maxUnits}
            </b>
            running
          </span>
        )}
      </div>
      <div className="spacer" />
      <ConnectionPill />
      <button type="button" className={`hbtn${legendOpen ? " active" : ""}`} onClick={onLegend} aria-pressed={legendOpen}>
        Legend
      </button>
    </header>
  );
}
