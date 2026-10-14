import { useShallow } from "zustand/react/shallow";
import { api } from "../api/client.js";
import { useFleet } from "../store/useFleet.js";
import { attentionQueue, nextAttention } from "../util/next.js";
import { enableSound } from "../util/sound.js";
import { reportError } from "./Toasts.js";

export function useCommands() {
  const st = useFleet;
  const nextOrders = () => {
    const s = st.getState();
    const cur = s.selection.length === 1 ? s.selection[0]! : null;
    const next = nextAttention(Object.values(s.units), cur);
    if (!next) {
      s.toast({ kind: "info", text: "Nothing needs orders right now." });
      return;
    }
    s.select([next.id]);
    s.focusUnit(next.id);
  };
  const recruit = (projectId?: string) => {
    const s = st.getState();
    if (!Object.keys(s.projects).length) {
      s.toast({ kind: "info", text: "Found a project first; units live inside a project's territory." });
      return s.setPanel({ kind: "newProject" });
    }
    s.setPanel({ kind: "recruit", projectId });
  };
  const newProject = () => {
    const s = st.getState();
    s.exitTerritory();
    s.setPanel(s.panel.kind === "newProject" ? { kind: "none" } : { kind: "newProject" });
  };
  const broadcast = () => {
    const s = st.getState();
    const ids = s.selection.length ? s.selection : Object.keys(s.units);
    s.setPanel({ kind: "group", ids });
    s.select(ids, { panel: false });
  };
  const move = () => {
    const s = st.getState();
    if (s.mode === "move") return s.exitMove();
    const id = s.selection[0];
    if (!id) return s.toast({ kind: "info", text: "Select a unit first, then pick a hex." });
    s.enterMove(id);
    s.toast({ kind: "info", text: `Moving ${s.units[id]?.name ?? id}: click a free hex. Esc cancels.` });
  };
  const haltAll = async () => {
    const s = st.getState();
    const busy = Object.values(s.units).filter((u) => u.status === "working" || u.status === "waiting");
    if (!busy.length) return s.toast({ kind: "info", text: "No unit is working." });
    if (!window.confirm(`Interrupt ${busy.length} working unit(s)?`)) return;
    await Promise.allSettled(busy.map((u) => api.units.interrupt(u.id)));
    s.toast({ kind: "ok", text: `Halted ${busy.length} unit(s).` });
  };
  const compactIdle = async () => {
    const s = st.getState();
    const idle = Object.values(s.units).filter((u) => u.status === "idle" || u.status === "done");
    if (!idle.length) return s.toast({ kind: "info", text: "No idle unit to compact." });
    await Promise.allSettled(idle.map((u) => api.units.compact(u.id)));
    s.toast({ kind: "ok", text: `Compacting ${idle.length} unit(s).` });
  };
  const toggleSound = () => {
    const s = st.getState();
    if (s.soundOn) return s.setSound(false);
    if (enableSound()) s.setSound(true);
    else s.toast({ kind: "error", text: "Audio is not available in this browser." });
  };
  return { nextOrders, recruit, newProject, broadcast, move, haltAll, compactIdle, toggleSound };
}

export function CommandBar() {
  const attention = useFleet(useShallow((s) => attentionQueue(Object.values(s.units)).length));
  const mode = useFleet((s) => s.mode);
  const soundOn = useFleet((s) => s.soundOn);
  const panel = useFleet((s) => s.panel);
  const c = useCommands();
  const run = (fn: () => unknown) => () => Promise.resolve(fn()).catch(reportError);
  return (
    <nav className="cmdbar" aria-label="commands">
      <button type="button" className={`cmd${attention ? " hot" : ""}`} onClick={run(c.nextOrders)} title="Next unit needing orders (N / Space)">
        <span className="k">N</span>Next orders{attention > 0 && <span className="badge">{attention}</span>}
      </button>
      <button type="button" className={`cmd${panel.kind === "recruit" ? " active" : ""}`} onClick={run(() => c.recruit())} title="Recruit a unit (R)">
        <span className="k">R</span>Recruit
      </button>
      <button type="button" className={`cmd${panel.kind === "newProject" ? " active" : ""}`} onClick={run(c.newProject)} title="Found a new project (P)">
        <span className="k">P</span>New project
      </button>
      <button type="button" className="cmd" onClick={run(c.broadcast)} title="Broadcast to the selection or the fleet (B)">
        <span className="k">B</span>Broadcast
      </button>
      <button type="button" className={`cmd${mode === "move" ? " active" : ""}`} onClick={run(c.move)} title="Move / reassign the selected unit (M)">
        <span className="k">M</span>Move
      </button>
      <div className="cmd-sep" />
      <button type="button" className="cmd" onClick={run(c.compactIdle)} title="Send /compact to every idle unit">
        Compact idle
      </button>
      <button type="button" className="cmd danger" onClick={run(c.haltAll)} title="Interrupt every working unit">
        Halt all
      </button>
      <div className="cmd-sep" />
      <button type="button" className={`cmd${soundOn ? " active" : ""}`} onClick={run(c.toggleSound)} aria-pressed={soundOn} title="Beep on alerts">
        Sound {soundOn ? "on" : "off"}
      </button>
      <button type="button" className={`cmd${panel.kind === "messages" ? " active" : ""}`} onClick={() => useFleet.getState().setPanel({ kind: "messages" })} title="All fleet messages">
        Messages
      </button>
      <button type="button" className={`cmd${panel.kind === "settings" ? " active" : ""}`} onClick={() => useFleet.getState().setPanel({ kind: "settings" })} title="Settings and notifications">
        Settings
      </button>
    </nav>
  );
}
