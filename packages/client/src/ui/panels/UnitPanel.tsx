import { useEffect, useRef, useState } from "react";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { STATUS_LABEL, shortModel } from "../../util/format.js";
import { reportError } from "../Toasts.js";
import { Orders } from "./Orders.js";
import { Transcript } from "./Transcript.js";
import { UnitSettings } from "./UnitSettings.js";

type Tab = "orders" | "transcript" | "messages" | "settings";

export function UnitPanel({ id, onClose, children }: { id: string; onClose: () => void; children?: React.ReactNode }) {
  const unit = useFleet((s) => s.units[id]);
  const type = useFleet((s) => (unit ? s.unitTypes[unit.type] : undefined));
  const project = useFleet((s) => (unit ? s.projects[unit.projectId] : undefined));
  const team = useFleet((s) => (unit?.teamId ? s.teams[unit.teamId] : undefined));
  const toast = useFleet((s) => s.toast);
  const [tab, setTab] = useState<Tab>("orders");
  const [task, setTask] = useState(unit?.task ?? "");
  const [editing, setEditing] = useState(false);
  const acked = useRef<string | null>(null);

  // opening a done unit acknowledges it
  useEffect(() => {
    if (unit?.status === "done" && acked.current !== `${id}:${unit.statusSince}`) {
      acked.current = `${id}:${unit.statusSince}`;
      api.units.ack(id).catch(() => {});
    }
  }, [id, unit?.status, unit?.statusSince]);
  useEffect(() => {
    if (!editing) setTask(unit?.task ?? "");
  }, [unit?.task, editing]);
  useEffect(() => {
    if (unit?.status === "waiting") setTab("orders");
  }, [unit?.status]);

  if (!unit) return null;
  const saveTask = () => {
    setEditing(false);
    if (task.trim() !== unit.task) api.units.patch(id, { task: task.trim() }).catch(reportError);
  };
  const copySession = () => {
    if (!unit.sessionId) return;
    navigator.clipboard?.writeText(unit.sessionId).then(() => toast({ kind: "ok", text: "Session id copied." })).catch(() => {});
  };

  return (
    <>
      <header>
        <span className="glyph" style={{ ["--type" as string]: type?.color }}>
          {type?.glyph}
        </span>
        <h2 title={unit.id}>{unit.name}</h2>
        <span className={`chip ${unit.status}`} aria-live="polite">
          <span className={`status-dot ${unit.status}`} />
          {STATUS_LABEL[unit.status]}
        </span>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="unit-meta">
        <div className="mono hint">
          {type?.rank} · {shortModel(unit.model)} · {project?.name}
          {team ? ` · ${team.name}` : ""}
          {unit.queueLength > 0 ? ` · +${unit.queueLength} queued` : ""}
          {unit.unreadInbox > 0 ? ` · ${unit.unreadInbox} unread` : ""}
        </div>
        <input
          className="mission"
          value={task}
          placeholder="mission line…"
          onFocus={() => setEditing(true)}
          onChange={(e) => setTask(e.target.value)}
          onBlur={saveTask}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            if (e.key === "Escape") {
              setTask(unit.task);
              setEditing(false);
              (e.target as HTMLInputElement).blur();
            }
          }}
          maxLength={200}
          aria-label="mission line"
        />
        <div className="activity-line" aria-live="polite">
          {unit.activity ? <span className="mono">{unit.activity}</span> : <span className="hint">{unit.status === "working" ? "…" : STATUS_LABEL[unit.status]}</span>}
          {unit.sessionId && (
            <button type="button" className="linkish mono" onClick={copySession} title="copy session id">
              {unit.sessionId.slice(0, 8)}… ⧉
            </button>
          )}
        </div>
      </div>
      <div className="tabs" role="tablist">
        {(["orders", "transcript", "messages", "settings"] as Tab[]).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} className={`tab${tab === t ? " active" : ""}`} onClick={() => setTab(t)}>
            {t}
            {t === "orders" && unit.status === "waiting" && <span className="badge">!</span>}
          </button>
        ))}
      </div>
      <div className="body" role="tabpanel">
        {tab === "orders" && <Orders unit={unit} />}
        {tab === "transcript" && <Transcript unitId={id} />}
        {tab === "messages" && (children ?? <div className="empty">Messages arrive with agent comms (M5).</div>)}
        {tab === "settings" && <UnitSettings unit={unit} />}
      </div>
    </>
  );
}
