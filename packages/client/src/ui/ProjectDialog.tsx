import { useState } from "react";
import type { CreateProjectBody } from "@gridcommander/shared";
import { api } from "../api/client.js";
import { useFleet } from "../store/useFleet.js";
import { reportError } from "./Toasts.js";
import { DirPicker } from "./DirPicker.js";

const SIZES: { value: 7 | 19 | 37; label: string }[] = [
  { value: 7, label: "Small · 7 hexes" },
  { value: 19, label: "Medium · 19 hexes" },
  { value: 37, label: "Large · 37 hexes" },
];

/** Found a new project: name, working directory, territory size. Colours come from the server palette. */
export function ProjectDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [size, setSize] = useState<7 | 19 | 37>(7);
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    try {
      const body: CreateProjectBody = { name: name.trim(), cwd: cwd.trim(), size };
      const p = await api.projects.create(body);
      const s = useFleet.getState();
      s.toast({ kind: "ok", text: `${p.name} founded with ${p.cells.length} hexes.` });
      s.setPanel({ kind: "project", id: p.id });
      s.focusProject(p.id);
    } catch (err) {
      reportError(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header>
        <h2>New project</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <form className="body form" onSubmit={submit}>
        <label>
          Name
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Billing API" autoFocus required maxLength={80} />
        </label>
        <label>
          Working directory <span className="hint">repo folder on the server; blank = fleet root</span>
          <span className="row2 inputrow">
            <input className="input mono" value={cwd} onChange={(e) => setCwd(e.target.value)} placeholder="/Users/you/src/billing-api" />
            <button type="button" className={`hbtn${browsing ? " active" : ""}`} onClick={() => setBrowsing((b) => !b)} aria-expanded={browsing}>
              Browse…
            </button>
          </span>
        </label>
        {browsing && (
          <DirPicker
            initial={cwd}
            onPick={(p) => {
              setCwd(p);
              setBrowsing(false);
              if (!name.trim()) setName(p.split("/").filter(Boolean).pop() ?? "");
            }}
            onCancel={() => setBrowsing(false)}
          />
        )}
        <label>
          Territory
          <select className="input" value={size} onChange={(e) => setSize(Number(e.target.value) as 7 | 19 | 37)}>
            {SIZES.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
              </option>
            ))}
          </select>
          <span className="hint">Placed in free water automatically. You can reshape it afterwards from the project panel.</span>
        </label>
        <button type="submit" className="btn" disabled={busy || !name.trim()}>
          {busy ? "Founding…" : "Found project"}
        </button>
      </form>
    </>
  );
}
