import { useShallow } from "zustand/react/shallow";
import { useFleet } from "../store/useFleet.js";
import { Legend } from "./Legend.js";
import { STATUS_LABEL, ago, shortModel } from "../util/format.js";

/** M3: read-only views. Command controls arrive in M4. */
export function SidePanel({ className = "side-panel" }: { className?: string }) {
  const panel = useFleet((s) => s.panel);
  const setPanel = useFleet((s) => s.setPanel);
  const clearSelection = useFleet((s) => s.clearSelection);
  if (panel.kind === "none") return null;
  const close = () => {
    clearSelection();
    setPanel({ kind: "none" });
  };
  return (
    <aside className={className} aria-live="polite">
      {panel.kind === "legend" && (
        <>
          <header>
            <h2>Legend</h2>
            <button type="button" className="xbtn" onClick={() => setPanel({ kind: "none" })} aria-label="close">
              ×
            </button>
          </header>
          <Legend />
        </>
      )}
      {panel.kind === "unit" && <UnitView id={panel.id} onClose={close} />}
      {panel.kind === "group" && <GroupView ids={panel.ids} onClose={close} />}
      {panel.kind === "project" && <ProjectView id={panel.id} onClose={close} />}
      {panel.kind === "team" && <TeamView id={panel.id} onClose={close} />}
      {(panel.kind === "recruit" || panel.kind === "settings") && (
        <>
          <header>
            <h2>{panel.kind}</h2>
            <button type="button" className="xbtn" onClick={close} aria-label="close">
              ×
            </button>
          </header>
          <div className="body">
            <div className="empty">Available in the command-and-control milestone.</div>
          </div>
        </>
      )}
    </aside>
  );
}

function UnitView({ id, onClose }: { id: string; onClose: () => void }) {
  const unit = useFleet((s) => s.units[id]);
  const type = useFleet((s) => (unit ? s.unitTypes[unit.type] : undefined));
  const project = useFleet((s) => (unit ? s.projects[unit.projectId] : undefined));
  const team = useFleet((s) => (unit?.teamId ? s.teams[unit.teamId] : undefined));
  if (!unit) return null;
  return (
    <>
      <header>
        <span className="glyph" style={{ ["--type" as string]: type?.color }}>
          {type?.glyph}
        </span>
        <h2>{unit.name}</h2>
        <span className={`chip ${unit.status}`}>
          <span className={`status-dot ${unit.status}`} />
          {STATUS_LABEL[unit.status]}
        </span>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
        <div className="mono" style={{ color: "var(--muted)" }}>
          {type?.rank} · {shortModel(unit.model)} · {project?.name}
          {team ? ` · ${team.name}` : ""}
        </div>
        <dl className="kv">
          <dt>Mission</dt>
          <dd>{unit.task || <span style={{ color: "var(--dim)" }}>none</span>}</dd>
          <dt>Activity</dt>
          <dd>{unit.activity ?? <span style={{ color: "var(--dim)" }}>—</span>}</dd>
          <dt>Since</dt>
          <dd className="mono">{ago(unit.statusSince)} ago</dd>
          <dt>Queue</dt>
          <dd className="mono">{unit.queueLength}</dd>
          <dt>Inbox</dt>
          <dd className="mono">{unit.unreadInbox} unread</dd>
          <dt>Permission</dt>
          <dd className="mono">{unit.permissionMode}</dd>
          <dt>Hex</dt>
          <dd className="mono">
            {unit.hex[0]}, {unit.hex[1]}
          </dd>
          <dt>Session</dt>
          <dd className="mono" style={{ color: "var(--muted)" }}>
            {unit.sessionId ?? "—"}
          </dd>
        </dl>
        {unit.pendingPermission && (
          <div>
            <h3 className="sec">Awaiting approval</h3>
            <div className="mono">{unit.pendingPermission.summary}</div>
          </div>
        )}
        {unit.lastResult && (
          <div>
            <h3 className="sec">Last result</h3>
            <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>{unit.lastResult.text.slice(0, 1200)}</div>
          </div>
        )}
      </div>
    </>
  );
}

function GroupView({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const units = useFleet(useShallow((s) => ids.map((i) => s.units[i]).filter(Boolean)));
  const unitTypes = useFleet((s) => s.unitTypes);
  return (
    <>
      <header>
        <h2>{units.length} units selected</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
        {units.map((u) => (
          <div key={u!.id} className="row" style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className="glyph" style={{ ["--type" as string]: unitTypes[u!.type]?.color }}>
              {unitTypes[u!.type]?.glyph}
            </span>
            <span style={{ flex: 1 }}>{u!.name}</span>
            <span className={`chip ${u!.status}`}>{STATUS_LABEL[u!.status]}</span>
          </div>
        ))}
      </div>
    </>
  );
}

function ProjectView({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useFleet((s) => s.projects[id]);
  const units = useFleet(useShallow((s) => Object.values(s.units).filter((u) => u.projectId === id)));
  if (!project) return null;
  const free = project.cells.length - units.length;
  return (
    <>
      <header>
        <span className="sw" style={{ background: project.flag, width: 14, height: 14 }} />
        <h2>{project.name}</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
        <dl className="kv">
          <dt>cwd</dt>
          <dd className="mono">{project.cwd || "(fleet root)"}</dd>
          <dt>Units</dt>
          <dd className="mono">
            {units.length} · {units.filter((u) => u.status === "working").length} working
          </dd>
          <dt>Free hexes</dt>
          <dd className="mono">{free}</dd>
        </dl>
      </div>
    </>
  );
}

function TeamView({ id, onClose }: { id: string; onClose: () => void }) {
  const team = useFleet((s) => s.teams[id]);
  const units = useFleet(useShallow((s) => (team ? team.memberIds.map((m) => s.units[m]).filter(Boolean) : [])));
  if (!team) return null;
  return (
    <>
      <header>
        <span className="sw" style={{ background: team.color, width: 14, height: 14 }} />
        <h2>{team.name}</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
        {units.map((u) => (
          <div key={u!.id} style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span className={`status-dot ${u!.status}`} />
            <span style={{ flex: 1 }}>{u!.name}</span>
            <span className="mono" style={{ color: "var(--muted)" }}>
              {STATUS_LABEL[u!.status]}
            </span>
          </div>
        ))}
      </div>
    </>
  );
}
