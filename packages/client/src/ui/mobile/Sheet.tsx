import { useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { selectOpenAlerts, selectUnitList, useFleet } from "../../store/useFleet.js";
import { STATUS_LABEL, ago, shortModel } from "../../util/format.js";
import { useAlertActions } from "../AlertStack.js";
import { useCommands } from "../CommandBar.js";
import { SidePanel } from "../SidePanel.js";

/** Bottom sheet: 52 % for detail, 78 % for list modes. Drag the handle down to close. */
export function Sheet() {
  const sheet = useFleet((s) => s.sheet);
  const setSheet = useFleet((s) => s.setSheet);
  const panel = useFleet((s) => s.panel);
  const multi = useFleet((s) => s.multi);
  const setMulti = useFleet((s) => s.setMulti);
  const [dragY, setDragY] = useState(0);
  const start = useRef<number | null>(null);
  const open = sheet !== "closed" && !(sheet === "detail" && panel.kind === "none");
  const tall = sheet === "units" || sheet === "alerts" || sheet === "commands";

  useEffect(() => {
    if (sheet === "detail" && panel.kind === "none") setSheet("closed");
  }, [sheet, panel.kind, setSheet]);

  const onPointerDown = (e: React.PointerEvent) => {
    start.current = e.clientY;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (start.current == null) return;
    setDragY(Math.max(0, e.clientY - start.current));
  };
  const onPointerUp = () => {
    if (start.current == null) return;
    if (dragY > 90) {
      setSheet("closed");
      if (panel.kind !== "none") useFleet.getState().clearSelection();
    }
    start.current = null;
    setDragY(0);
  };

  if (!open) return null;
  return (
    <div className={`sheet${tall ? " tall" : ""}`} style={dragY ? { transform: `translateY(${dragY}px)` } : undefined} role="dialog" aria-label={sheet}>
      <div className="sheet-handle" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}>
        <span />
        {sheet === "detail" && (
          <button type="button" className={`multi${multi ? " on" : ""}`} onClick={() => setMulti(!multi)} aria-pressed={multi}>
            + multi
          </button>
        )}
      </div>
      <div className="sheet-body">
        {sheet === "units" && <UnitsList />}
        {sheet === "alerts" && <AlertsList />}
        {sheet === "commands" && <CommandsList />}
        {sheet === "detail" && <SidePanel className="sheet-panel" />}
      </div>
    </div>
  );
}

function UnitsList() {
  const units = useFleet(useShallow(selectUnitList));
  const projects = useFleet((s) => s.projects);
  const unitTypes = useFleet((s) => s.unitTypes);
  const select = useFleet((s) => s.select);
  const focusUnit = useFleet((s) => s.focusUnit);
  const setSheet = useFleet((s) => s.setSheet);
  const multi = useFleet((s) => s.multi);
  const selection = useFleet((s) => s.selection);
  return (
    <div className="list">
      {units.map((u) => (
        <button
          key={u.id}
          type="button"
          className={`member${selection.includes(u.id) ? " sel" : ""}`}
          onClick={() => {
            if (multi) useFleet.getState().toggleSelect(u.id);
            else {
              select([u.id]);
              focusUnit(u.id);
              setSheet("detail");
            }
          }}
        >
          <span className="glyph" style={{ ["--type" as string]: unitTypes[u.type]?.color }}>
            {unitTypes[u.type]?.glyph}
          </span>
          <span className="member-name">
            {u.name}
            <span className="hint" style={{ display: "block" }}>
              {shortModel(u.model)} · {projects[u.projectId]?.name}
              {u.queueLength ? ` · +${u.queueLength}` : ""}
            </span>
          </span>
          <span className={`chip ${u.status}`}>{STATUS_LABEL[u.status]}</span>
        </button>
      ))}
    </div>
  );
}

function AlertsList() {
  const alerts = useFleet(useShallow(selectOpenAlerts));
  const setSheet = useFleet((s) => s.setSheet);
  const { jump, dismiss, dismissAll } = useAlertActions();
  if (!alerts.length) return <div className="empty">No open alerts.</div>;
  return (
    <div className="list">
      <button type="button" className="hbtn small" onClick={dismissAll}>
        dismiss all ({alerts.length})
      </button>
      {alerts.map((a) => (
        <div key={a.id} className={`alert ${a.kind}`}>
          <button
            type="button"
            className="alert-main"
            onClick={() => {
              jump(a);
              setSheet("detail");
            }}
          >
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
      ))}
    </div>
  );
}

function CommandsList() {
  const c = useCommands();
  const setSheet = useFleet((s) => s.setSheet);
  const setPanel = useFleet((s) => s.setPanel);
  const soundOn = useFleet((s) => s.soundOn);
  const mode = useFleet((s) => s.mode);
  const run = (fn: () => unknown, then?: "detail" | "closed") => () =>
    Promise.resolve(fn())
      .then(() => then && setSheet(then))
      .catch(() => {});
  return (
    <div className="list cmd-list">
      <button type="button" className="cmd" onClick={run(() => c.recruit(), "detail")}>
        Recruit a unit
      </button>
      <button type="button" className="cmd" onClick={run(c.broadcast, "detail")}>
        Broadcast to selection / fleet
      </button>
      <button type="button" className={`cmd${mode === "move" ? " active" : ""}`} onClick={run(c.move, "closed")}>
        Move selected unit
      </button>
      <button type="button" className="cmd" onClick={run(() => setPanel({ kind: "messages" }), "detail")}>
        Messages
      </button>
      <button type="button" className="cmd" onClick={run(() => setPanel({ kind: "legend" }), "detail")}>
        Legend
      </button>
      <button type="button" className="cmd" onClick={run(() => setPanel({ kind: "settings" }), "detail")}>
        Settings &amp; notifications
      </button>
      <div className="cmd-sep" />
      <button type="button" className="cmd" onClick={run(c.compactIdle, "closed")}>
        Compact idle units
      </button>
      <button type="button" className="cmd danger" onClick={run(c.haltAll, "closed")}>
        Halt all
      </button>
      <button type="button" className={`cmd${soundOn ? " active" : ""}`} onClick={c.toggleSound}>
        Sound {soundOn ? "on" : "off"}
      </button>
    </div>
  );
}
