import { useEffect, useState } from "react";
import { api } from "../../api/client.js";
import { urlBase64ToUint8Array } from "../../pwa.js";
import { useFleet } from "../../store/useFleet.js";
import { useCommands } from "../CommandBar.js";
import { reportError } from "../Toasts.js";

export function SettingsPanel({ onClose }: { onClose: () => void }) {
  const server = useFleet((s) => s.server);
  const settings = useFleet((s) => s.settings);
  const soundOn = useFleet((s) => s.soundOn);
  const toast = useFleet((s) => s.toast);
  const { toggleSound } = useCommands();
  const [sub, setSub] = useState<PushSubscription | null | "unsupported">(null);
  const [busy, setBusy] = useState(false);
  const secure = typeof window !== "undefined" && window.isSecureContext;

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      setSub("unsupported");
      return;
    }
    navigator.serviceWorker.ready.then((reg) => reg.pushManager.getSubscription()).then(setSub).catch(() => setSub("unsupported"));
  }, []);

  const enable = async () => {
    setBusy(true);
    try {
      const perm = await Notification.requestPermission();
      if (perm !== "granted") throw new Error("Notifications were not allowed by the browser.");
      const { key } = await api.push.key();
      if (!key) throw new Error("The server has no VAPID keys (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).");
      const reg = await navigator.serviceWorker.ready;
      const s = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(key) as BufferSource });
      await api.push.subscribe(s.toJSON());
      setSub(s);
      toast({ kind: "ok", text: "Push notifications enabled on this device." });
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const disable = async () => {
    if (!sub || sub === "unsupported") return;
    setBusy(true);
    try {
      await api.push.unsubscribe(sub.endpoint);
      await sub.unsubscribe();
      setSub(null);
      toast({ kind: "ok", text: "Push disabled on this device." });
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };
  const patch = (b: Parameters<typeof api.settings.patch>[0]) => api.settings.patch(b).catch(reportError);
  const kinds = settings?.["push.kinds"] ?? [];
  const toggleKind = (k: "waiting" | "error" | "done" | "idle" | "message" | "info") =>
    patch({ "push.kinds": kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k] });

  return (
    <>
      <header>
        <h2>Settings</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body form">
        <h3 className="sec">Notifications</h3>
        {sub === "unsupported" ? (
          <div className="hint">This browser does not support Web Push{secure ? "" : " (the page must be served over HTTPS)"}.</div>
        ) : sub ? (
          <button type="button" className="hbtn" disabled={busy} onClick={disable}>
            Disable push on this device
          </button>
        ) : (
          <button type="button" className="btn" disabled={busy || !server?.pushEnabled} onClick={enable}>
            {server?.pushEnabled ? "Enable push on this device" : "Push not configured on server"}
          </button>
        )}
        <div className="hint">
          Push only arrives while Chrome is alive on Android (it is not a system service); the app also needs HTTPS to install, see the README for
          tailscale serve / mkcert.
        </div>
        <div className="swatches">
          {(["waiting", "error", "done", "idle", "message", "info"] as const).map((k) => (
            <label key={k} className="check">
              <input type="checkbox" checked={kinds.includes(k)} onChange={() => toggleKind(k)} /> {k}
            </label>
          ))}
        </div>
        <h3 className="sec">Alerts</h3>
        <label>
          Idle alert after (minutes)
          <input
            className="input"
            type="number"
            min={1}
            defaultValue={Math.round((settings?.["alerts.idleMs"] ?? 120000) / 60000)}
            onBlur={(e) => patch({ "alerts.idleMs": Math.max(1, Number(e.target.value)) * 60000 })}
          />
        </label>
        <label>
          Auto-acknowledge done after (minutes)
          <input
            className="input"
            type="number"
            min={1}
            defaultValue={Math.round((settings?.["alerts.doneAutoAckMs"] ?? 600000) / 60000)}
            onBlur={(e) => patch({ "alerts.doneAutoAckMs": Math.max(1, Number(e.target.value)) * 60000 })}
          />
        </label>
        <label className="check">
          <input type="checkbox" checked={soundOn} onChange={toggleSound} /> sound on alerts
        </label>
        <h3 className="sec">Comms</h3>
        <label className="check">
          <input type="checkbox" checked={!!settings?.["comms.crossProject"]} onChange={(e) => patch({ "comms.crossProject": e.target.checked })} /> allow every unit to message across
          projects
        </label>
        {server && (
          <div className="hint mono">
            server {server.version} · up {Math.round(server.uptime / 60000)} min · {server.runningUnits}/{server.maxUnits} running
          </div>
        )}
      </div>
    </>
  );
}
