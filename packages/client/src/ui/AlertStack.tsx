import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Alert } from "@gridcommander/shared";
import { api } from "../api/client.js";
import { selectOpenAlerts, useFleet } from "../store/useFleet.js";
import { ago } from "../util/format.js";
import { beep } from "../util/sound.js";
import { reportError } from "./Toasts.js";

export function useAlertActions() {
  const jump = (a: Alert) => {
    const s = useFleet.getState();
    if (a.unitId && s.units[a.unitId]) {
      s.select([a.unitId]);
      s.focusUnit(a.unitId);
    }
    api.alerts.dismiss(a.id).catch(() => {});
  };
  const dismiss = (a: Alert) => api.alerts.dismiss(a.id).catch(reportError);
  const dismissAll = () => api.alerts.dismissAll().catch(reportError);
  return { jump, dismiss, dismissAll };
}

/** Plays a beep for new alerts when sound is on. Mount once. */
export function useAlertSounds() {
  const seen = useRef<Set<string>>(new Set());
  const alerts = useFleet((s) => s.alerts);
  const soundOn = useFleet((s) => s.soundOn);
  useEffect(() => {
    for (const a of Object.values(alerts)) {
      const key = `${a.id}:${a.createdAt}`;
      if (seen.current.has(key)) continue;
      seen.current.add(key);
      if (soundOn) beep(a.kind);
    }
    if (seen.current.size > 2000) seen.current.clear();
  }, [alerts, soundOn]);
}

export function AlertStack({ shifted }: { shifted: boolean }) {
  const alerts = useFleet(useShallow(selectOpenAlerts));
  const unitTypes = useFleet((s) => s.unitTypes);
  const units = useFleet((s) => s.units);
  const { jump, dismiss, dismissAll } = useAlertActions();
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 15_000);
    return () => clearInterval(t);
  }, []);
  if (!alerts.length) return null;
  return (
    <div className={`alerts${shifted ? " shifted" : ""}`} role="region" aria-live="polite" aria-label="alerts">
      {alerts.length > 1 && (
        <button type="button" className="alerts-clear" onClick={dismissAll}>
          dismiss all ({alerts.length})
        </button>
      )}
      {alerts.slice(0, 12).map((a) => {
        const unit = a.unitId ? units[a.unitId] : undefined;
        const type = unit ? unitTypes[unit.type] : undefined;
        return (
          <div key={a.id} className={`alert ${a.kind}`}>
            <button type="button" className="alert-main" onClick={() => jump(a)} title="Jump to unit">
              {type ? (
                <span className="glyph" style={{ ["--type" as string]: type.color }}>
                  {type.glyph}
                </span>
              ) : (
                <span className="glyph" style={{ ["--type" as string]: "#9aa3ad" }}>
                  !
                </span>
              )}
              <span className="alert-text">
                <span className="alert-title">{a.title}</span>
                <span className="alert-body">{a.body}</span>
              </span>
              <span className="alert-age">{ago(a.createdAt)}</span>
            </button>
            <button type="button" className="alert-x" onClick={() => dismiss(a)} aria-label="dismiss">
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
