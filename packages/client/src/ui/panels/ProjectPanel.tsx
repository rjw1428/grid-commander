import { useShallow } from "zustand/react/shallow";
import { useFleet } from "../../store/useFleet.js";
import { STATUS_LABEL } from "../../util/format.js";

export function ProjectPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useFleet((s) => s.projects[id]);
  const units = useFleet(useShallow((s) => Object.values(s.units).filter((u) => u.projectId === id)));
  const unitTypes = useFleet((s) => s.unitTypes);
  const select = useFleet((s) => s.select);
  const setPanel = useFleet((s) => s.setPanel);
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
            {units.length} · {units.filter((u) => u.status === "working").length} working · {units.filter((u) => u.status === "waiting").length} waiting
          </dd>
          <dt>Free hexes</dt>
          <dd className="mono">{free}</dd>
        </dl>
        <div className="row-btns">
          <button type="button" className="btn" onClick={() => setPanel({ kind: "recruit", projectId: id })} disabled={free <= 0}>
            Recruit here
          </button>
          <button type="button" className="hbtn" onClick={() => select(units.map((u) => u.id))} disabled={!units.length}>
            Select all
          </button>
        </div>
        <div className="member-list">
          {units.map((u) => (
            <button key={u.id} type="button" className="member" onClick={() => select([u.id])}>
              <span className="glyph" style={{ ["--type" as string]: unitTypes[u.type]?.color }}>
                {unitTypes[u.type]?.glyph}
              </span>
              <span className="member-name">{u.name}</span>
              <span className={`chip ${u.status}`}>{STATUS_LABEL[u.status]}</span>
            </button>
          ))}
        </div>
      </div>
    </>
  );
}
