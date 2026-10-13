import { useShallow } from "zustand/react/shallow";
import { selectUnitList, useFleet } from "../store/useFleet.js";
import { STATUS_LABEL, shortModel } from "../util/format.js";

export function Tray() {
  const units = useFleet(useShallow(selectUnitList));
  const teams = useFleet((s) => s.teams);
  const projects = useFleet((s) => s.projects);
  const unitTypes = useFleet((s) => s.unitTypes);
  const selection = useFleet((s) => s.selection);
  const select = useFleet((s) => s.select);
  const focusUnit = useFleet((s) => s.focusUnit);
  const setPanel = useFleet((s) => s.setPanel);

  return (
    <nav className="tray" aria-label="roster">
      {Object.values(teams).map((t) => {
        const allSelected = t.memberIds.length > 0 && t.memberIds.every((m) => selection.includes(m));
        return (
          <button
            key={t.id}
            type="button"
            className={`tray-card team${allSelected ? " selected" : ""}`}
            style={{ ["--team" as string]: t.color }}
            onClick={() => {
              select(t.memberIds);
              setPanel({ kind: "team", id: t.id });
            }}
          >
            <div className="row">
              <span className="sw" style={{ background: t.color }} />
              <span className="name">{t.name}</span>
            </div>
            <div className="sub">{t.memberIds.length} units · team</div>
          </button>
        );
      })}
      {Object.keys(teams).length > 0 && <div className="tray-sep" />}
      {units.map((u) => {
        const type = unitTypes[u.type];
        const project = projects[u.projectId];
        return (
          <button
            key={u.id}
            type="button"
            className={`tray-card${selection.includes(u.id) ? " selected" : ""}`}
            style={{ ["--flag" as string]: project?.flag ?? "#888", ["--type" as string]: type?.color ?? "#888" }}
            onClick={(e) => {
              if (e.shiftKey) useFleet.getState().toggleSelect(u.id);
              else select([u.id]);
              focusUnit(u.id);
            }}
            title={`${u.name} · ${type?.name ?? u.type} · ${project?.name ?? u.projectId}`}
          >
            <div className="row">
              <span className="glyph">{type?.glyph ?? "?"}</span>
              <span className="name">{u.name}</span>
            </div>
            <div className="row sub">
              <span className={`status-dot ${u.status}`} />
              <span>{STATUS_LABEL[u.status]}</span>
              {u.queueLength > 0 && <span style={{ color: "var(--gold-2)" }}>+{u.queueLength}</span>}
            </div>
            <div className="sub">
              {shortModel(u.model)} · {project?.name ?? u.projectId}
            </div>
          </button>
        );
      })}
    </nav>
  );
}
