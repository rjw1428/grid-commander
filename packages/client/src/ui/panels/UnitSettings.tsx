import { useState } from "react";
import type { PermissionMode, Unit } from "@hexcommand/shared";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { useCommands } from "../CommandBar.js";
import { reportError } from "../Toasts.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

async function exportTranscript(id: string, name: string) {
  try {
    const { getToken } = await import("../../api/token.js");
    const res = await fetch(`/api/units/${id}/transcript.md`, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
    if (!res.ok) throw new Error(`export failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${name}-transcript.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  } catch (err) {
    reportError(err);
  }
}

export function UnitSettings({ unit }: { unit: Unit }) {
  const teams = useFleet((s) => s.teams);
  const projects = useFleet((s) => s.projects);
  const toast = useFleet((s) => s.toast);
  const { move } = useCommands();
  const [name, setName] = useState(unit.name);
  const [newTeam, setNewTeam] = useState("");
  const patch = (b: Parameters<typeof api.units.patch>[1]) => api.units.patch(unit.id, b).catch(reportError);

  const remove = async () => {
    if (!window.confirm(`Remove ${unit.name}? The session can still be resumed in a terminal with claude --resume ${unit.sessionId ?? "<id>"}.`)) return;
    try {
      await api.units.remove(unit.id);
      useFleet.getState().clearSelection();
      toast({ kind: "ok", text: `${unit.name} removed.` });
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <div className="form">
      <label>
        Name
        <div className="row2">
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={40} />
          <button type="button" className="hbtn" disabled={name.trim() === unit.name || !name.trim()} onClick={() => patch({ name: name.trim() })}>
            Rename
          </button>
        </div>
      </label>
      <label>
        Model <span className="hint">applied live</span>
        <select className="input" value={unit.model} onChange={(e) => patch({ model: e.target.value })}>
          {[unit.model, "opus", "sonnet", "haiku"].filter((m, i, a) => a.indexOf(m) === i).map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Permission mode <span className="hint">applied live</span>
        <select className="input" value={unit.permissionMode} onChange={(e) => patch({ permissionMode: e.target.value as PermissionMode })}>
          {MODES.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
      </label>
      <label>
        Team
        <select className="input" value={unit.teamId ?? ""} onChange={(e) => patch({ teamId: e.target.value || null })}>
          <option value="">— none —</option>
          {Object.values(teams).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <div className="row2">
          <input className="input" placeholder="new team name" value={newTeam} onChange={(e) => setNewTeam(e.target.value)} />
          <button
            type="button"
            className="hbtn"
            disabled={!newTeam.trim()}
            onClick={() =>
              api.teams
                .create({ name: newTeam.trim(), memberIds: [unit.id] })
                .then(() => setNewTeam(""))
                .catch(reportError)
            }
          >
            Create
          </button>
        </div>
      </label>
      <label>
        Project
        <select className="input" value={unit.projectId} onChange={(e) => patch({ projectId: e.target.value })}>
          {Object.values(projects).map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <span className="hint">changing project moves the unit to that territory's first free hex; new turns use the new cwd after a restart</span>
      </label>
      <label className="check">
        <input type="checkbox" checked={!!unit.autostart} onChange={(e) => patch({ autostart: e.target.checked })} /> start when the server boots
      </label>
      <div className="row-btns">
        <button type="button" className="hbtn" onClick={move}>
          Move on map (M)
        </button>
        <a className="hbtn" href={`/api/units/${unit.id}/transcript.md`} download={`${unit.name}-transcript.md`} onClick={(e) => { e.preventDefault(); void exportTranscript(unit.id, unit.name); }}>
          Export transcript (.md)
        </a>
        <button type="button" className="hbtn danger" onClick={remove}>
          Remove unit
        </button>
      </div>
      {unit.sessionId && (
        <div className="hint mono">
          Take over in a terminal after Stop: <code>claude --resume {unit.sessionId}</code>
        </div>
      )}
    </div>
  );
}
