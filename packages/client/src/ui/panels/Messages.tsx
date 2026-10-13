import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { Message, MessageTarget, Priority } from "@gridcommander/shared";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { ago } from "../../util/format.js";
import { reportError } from "../Toasts.js";

function nameOf(id: string, units: Record<string, { name: string }>) {
  return id === "operator" ? "operator" : (units[id]?.name ?? id);
}

export function Messages({ unitId }: { unitId: string }) {
  const unit = useFleet((s) => s.units[unitId]);
  const units = useFleet((s) => s.units);
  const teams = useFleet((s) => s.teams);
  const projects = useFleet((s) => s.projects);
  const live = useFleet(useShallow((s) => s.messages.filter((m) => m.from === unitId || m.relayedFrom === unitId || unitId in m.deliveries)));
  const toast = useFleet((s) => s.toast);
  const [history, setHistory] = useState<Message[]>([]);
  const [to, setTo] = useState<string>(`unit:${unitId}`);
  const [priority, setPriority] = useState<Priority>("normal");
  const [body, setBody] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);

  useEffect(() => {
    let on = true;
    api.units
      .messages(unitId)
      .then((r) => on && setHistory(r.messages))
      .catch(reportError);
    return () => {
      on = false;
    };
  }, [unitId]);

  const all = useMemo(() => {
    const map = new Map<string, Message>();
    for (const m of [...history, ...live]) map.set(m.id, m);
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt);
  }, [history, live]);

  const threads = useMemo(() => {
    const t = new Map<string, Message[]>();
    for (const m of all) t.set(m.threadId, [...(t.get(m.threadId) ?? []), m]);
    return [...t.values()].sort((a, b) => b[b.length - 1]!.createdAt - a[a.length - 1]!.createdAt);
  }, [all]);

  const targetFromKey = (key: string): MessageTarget => {
    const [kind, id] = key.split(":") as [string, string];
    if (kind === "fleet") return { kind: "fleet" };
    if (kind === "team") return { kind: "team", id };
    if (kind === "project") return { kind: "project", id };
    return { kind: "unit", id };
  };

  const send = async (relay = false) => {
    if (!body.trim() && !relay) return;
    try {
      await api.messages.send({ to: targetFromKey(to), body: body.trim(), priority, ...(replyTo ? { replyTo } : {}), ...(relay ? { relayedFrom: unitId } : {}) });
      setBody("");
      setReplyTo(null);
      toast({ kind: "ok", text: relay ? "Output relayed." : "Message sent." });
    } catch (err) {
      reportError(err);
    }
  };

  if (!unit) return null;
  return (
    <div className="messages">
      <div className="compose card">
        <div className="row2">
          <select className="input" value={to} onChange={(e) => setTo(e.target.value)} aria-label="recipient">
            <optgroup label="Units">
              {Object.values(units).map((u) => (
                <option key={u.id} value={`unit:${u.id}`}>
                  {u.name}
                </option>
              ))}
            </optgroup>
            <optgroup label="Groups">
              {Object.values(teams).map((t) => (
                <option key={t.id} value={`team:${t.id}`}>
                  team {t.name}
                </option>
              ))}
              {Object.values(projects).map((p) => (
                <option key={p.id} value={`project:${p.id}`}>
                  project {p.name}
                </option>
              ))}
              <option value="fleet:">whole fleet</option>
            </optgroup>
          </select>
          <select className="input" value={priority} onChange={(e) => setPriority(e.target.value as Priority)} aria-label="priority">
            <option value="normal">normal</option>
            <option value="urgent">urgent</option>
          </select>
        </div>
        {replyTo && (
          <div className="hint">
            replying in thread {replyTo.slice(0, 6)}…{" "}
            <button type="button" className="linkish" onClick={() => setReplyTo(null)}>
              cancel
            </button>
          </div>
        )}
        <textarea className="input" rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Message from the operator…" />
        <div className="row-btns">
          <button type="button" className="btn" disabled={!body.trim()} onClick={() => send(false)}>
            Send
          </button>
          <button type="button" className="hbtn" disabled={!unit.lastResult?.text} title="Send this unit's last result to the recipient" onClick={() => send(true)}>
            Relay output
          </button>
        </div>
      </div>
      {threads.length === 0 && <div className="empty">No messages yet.</div>}
      {threads.map((thread) => (
        <div key={thread[0]!.threadId} className="thread">
          {thread.map((m) => {
            const out = m.from === unitId;
            const recipients = Object.keys(m.deliveries);
            const d = m.deliveries[unitId];
            return (
              <div key={m.id} className={`msg${out ? " out" : ""}${m.priority === "urgent" ? " urgent" : ""}`}>
                <div className="msg-head">
                  <b>{m.relayedFrom ? `${nameOf(m.relayedFrom, units)} (relayed by operator)` : nameOf(m.from, units)}</b>
                  <span className="hint">
                    → {m.to.kind === "unit" ? nameOf(m.to.id, units) : m.to.kind === "fleet" ? "fleet" : `${m.to.kind} ${m.to.id}`}
                    {recipients.length > 1 ? ` (${recipients.length})` : ""} · {ago(m.createdAt)}
                    {m.priority === "urgent" ? " · urgent" : ""}
                    {d?.how ? ` · ${d.how}` : d && !d.deliveredAt && !out ? " · pending" : ""}
                  </span>
                  <button type="button" className="linkish" onClick={() => setReplyTo(m.threadId)}>
                    reply
                  </button>
                </div>
                <pre>{m.body}</pre>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
