import { useState } from "react";
import type { PermissionMode } from "@gridcommander/shared";
import { api } from "../api/client.js";
import { useFleet } from "../store/useFleet.js";
import { reportError } from "./Toasts.js";

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk", "auto"];

export function RecruitDialog({ projectId, onClose }: { projectId?: string; onClose: () => void }) {
  const projects = useFleet((s) => s.projects);
  const unitTypes = useFleet((s) => s.unitTypes);
  const units = useFleet((s) => s.units);
  const firstProject = projectId ?? Object.keys(projects).find((id) => id !== "hq") ?? Object.keys(projects)[0] ?? "";
  const [name, setName] = useState("");
  const [type, setType] = useState("infantry");
  const [project, setProject] = useState(firstProject);
  const [order, setOrder] = useState("");
  const [model, setModel] = useState("");
  const [mode, setMode] = useState<PermissionMode | "">("");
  const [busy, setBusy] = useState(false);
  const typeDef = unitTypes[type];
  const proj = projects[project];
  const free = proj ? proj.cells.length - Object.values(units).filter((u) => u.projectId === project).length : 0;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !project) return;
    setBusy(true);
    try {
      const u = await api.units.create({
        name: name.trim(),
        type,
        projectId: project,
        ...(order.trim() ? { firstOrder: order.trim() } : {}),
        ...(model ? { model } : {}),
        ...(mode ? { permissionMode: mode } : {}),
        start: true,
      });
      const s = useFleet.getState();
      s.toast({ kind: "ok", text: `${u.name} recruited to ${proj?.name ?? project}.` });
      s.select([u.id]);
      s.focusUnit(u.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header>
        <h2>Recruit</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <form className="body form" onSubmit={submit}>
        <label>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. xre-tests" autoFocus required maxLength={40} />
        </label>
        <label>
          Rank
          <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
            {Object.values(unitTypes).map((t) => (
              <option key={t.id} value={t.id}>
                {t.name} — {t.model} — {t.role.split(".")[0]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project
          <select className="input" value={project} onChange={(e) => setProject(e.target.value)}>
            {Object.values(projects).map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
          <span className="hint">{free} free hex{free === 1 ? "" : "es"}</span>
        </label>
        <label>
          First order <span className="hint">optional</span>
          <textarea className="input" rows={3} value={order} onChange={(e) => setOrder(e.target.value)} placeholder="What should it do first?" />
        </label>
        <div className="row2">
          <label>
            Model <span className="hint">default {typeDef?.model}</span>
            <select className="input" value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">type default</option>
              <option value="opus">opus</option>
              <option value="sonnet">sonnet</option>
              <option value="haiku">haiku</option>
            </select>
          </label>
          <label>
            Permissions <span className="hint">default {typeDef?.defaultPermissionMode}</span>
            <select className="input" value={mode} onChange={(e) => setMode(e.target.value as PermissionMode | "")}>
              <option value="">type default</option>
              {MODES.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          </label>
        </div>
        <button type="submit" className="btn" disabled={busy || !name.trim() || free <= 0}>
          {busy ? "Recruiting…" : free <= 0 ? "No free hex" : "Recruit & start"}
        </button>
      </form>
    </>
  );
}
