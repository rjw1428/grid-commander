import { useEffect, useMemo, useState } from "react";
import type { Message } from "@hexcommand/shared";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { ago } from "../../util/format.js";
import { reportError } from "../Toasts.js";

export function AllMessages({ onClose }: { onClose: () => void }) {
  const units = useFleet((s) => s.units);
  const live = useFleet((s) => s.messages);
  const select = useFleet((s) => s.select);
  const [history, setHistory] = useState<Message[]>([]);
  useEffect(() => {
    api.messages
      .list()
      .then((r) => setHistory(r.messages))
      .catch(reportError);
  }, []);
  const all = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of [...history, ...live]) map.set(m.id, m);
    return [...map.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, 200);
  }, [history, live]);
  const name = (id: string) => (id === "operator" ? "operator" : (units[id]?.name ?? id));
  return (
    <>
      <header>
        <h2>Messages</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
        {all.length === 0 && <div className="empty">No messages yet. Units talk through fleet_send; you can message any unit from its Messages tab.</div>}
        {all.map((m) => (
          <div key={m.id} className={`msg${m.priority === "urgent" ? " urgent" : ""}`}>
            <div className="msg-head">
              <button type="button" className="linkish" style={{ fontWeight: 600, color: "var(--text)" }} onClick={() => m.from !== "operator" && select([m.from])}>
                {m.relayedFrom ? `${name(m.relayedFrom)} (relayed)` : name(m.from)}
              </button>
              <span className="hint">
                → {m.to.kind === "unit" ? name(m.to.id) : m.to.kind === "fleet" ? "fleet" : `${m.to.kind} ${m.to.id}`} · {ago(m.createdAt)}
                {m.priority === "urgent" ? " · urgent" : ""}
              </span>
            </div>
            <pre>{m.body.length > 400 ? m.body.slice(0, 400) + "…" : m.body}</pre>
          </div>
        ))}
      </div>
    </>
  );
}
