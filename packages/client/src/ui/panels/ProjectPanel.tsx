import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { STATUS_LABEL } from "../../util/format.js";
import { reportError } from "../Toasts.js";

export function ProjectPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const project = useFleet((s) => s.projects[id]);
  const units = useFleet(useShallow((s) => Object.values(s.units).filter((u) => u.projectId === id)));
  const unitTypes = useFleet((s) => s.unitTypes);
  const select = useFleet((s) => s.select);
  const setPanel = useFleet((s) => s.setPanel);
  const mode = useFleet((s) => s.mode);
  const territoryId = useFleet((s) => s.territoryProjectId);
  const enterTerritory = useFleet((s) => s.enterTerritory);
  const exitTerritory = useFleet((s) => s.exitTerritory);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [tint, setTint] = useState("#000000");
  const [flag, setFlag] = useState("#000000");
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  useEffect(() => {
    if (!project) return;
    setName(project.name);
    setCwd(project.cwd);
    setTint(project.tint);
    setFlag(project.flag);
    setConfirmDelete(false);
  }, [project?.id, editing]);

  if (!project) return null;
  const free = project.cells.length - units.length;
  const editingTerritory = mode === "territory" && territoryId === id;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.projects.patch(id, { name: name.trim(), cwd: cwd.trim(), tint, flag });
      useFleet.getState().toast({ kind: "ok", text: `${name.trim()} updated.` });
      setEditing(false);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.projects.remove(id);
      useFleet.getState().toast({ kind: "ok", text: `${project.name} removed.` });
      onClose();
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

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
        {editing ? (
          <form className="form" onSubmit={save}>
            <label>
              Name
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
            </label>
            <label>
              Working directory <span className="hint">blank = fleet root</span>
              <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/path/to/repo" />
            </label>
            <div className="row2">
              <label>
                Territory tint
                <span className="color-row">
                  <input type="color" value={tint} onChange={(e) => setTint(e.target.value)} aria-label="territory tint" />
                  <span className="mono">{tint}</span>
                </span>
              </label>
              <label>
                Flag colour
                <span className="color-row">
                  <input type="color" value={flag} onChange={(e) => setFlag(e.target.value)} aria-label="flag colour" />
                  <span className="mono">{flag}</span>
                </span>
              </label>
            </div>
            <div className="row-btns">
              <button type="submit" className="btn" disabled={busy || !name.trim()}>
                Save
              </button>
              <button type="button" className="hbtn" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <dl className="kv">
            <dt>cwd</dt>
            <dd className="mono">{project.cwd || "(fleet root)"}</dd>
            <dt>Units</dt>
            <dd className="mono">
              {units.length} · {units.filter((u) => u.status === "working").length} working · {units.filter((u) => u.status === "waiting").length} waiting
            </dd>
            <dt>Territory</dt>
            <dd className="mono">
              {project.cells.length} hexes · {free} free
            </dd>
          </dl>
        )}
        <div className="row-btns">
          <button type="button" className="btn" onClick={() => setPanel({ kind: "recruit", projectId: id })} disabled={free <= 0}>
            Recruit here
          </button>
          <button type="button" className="hbtn" onClick={() => select(units.map((u) => u.id))} disabled={!units.length}>
            Select all
          </button>
        </div>
        <h3 className="sec">Manage</h3>
        <div className="row-btns">
          {!editing && (
            <button type="button" className="hbtn" onClick={() => setEditing(true)}>
              Edit details
            </button>
          )}
          <button type="button" className={`hbtn${editingTerritory ? " active" : ""}`} onClick={() => (editingTerritory ? exitTerritory() : enterTerritory(id))} aria-pressed={editingTerritory}>
            {editingTerritory ? "Done editing territory" : "Edit territory"}
          </button>
        </div>
        {editingTerritory && <p className="hint">Click a translucent hex to claim it, click one of this project's hexes to release it. Hexes with a unit on them stay.</p>}
        {!confirmDelete ? (
          <button type="button" className="hbtn danger small" onClick={() => setConfirmDelete(true)} disabled={units.length > 0} title={units.length ? "Remove its units first" : undefined}>
            Delete project
          </button>
        ) : (
          <div className="row-btns">
            <button type="button" className="btn danger" onClick={remove} disabled={busy}>
              Confirm delete
            </button>
            <button type="button" className="hbtn" onClick={() => setConfirmDelete(false)}>
              Keep
            </button>
          </div>
        )}
        {units.length > 0 && (
          <>
            <h3 className="sec">Units</h3>
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
          </>
        )}
      </div>
    </>
  );
}
