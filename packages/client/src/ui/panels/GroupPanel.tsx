import { useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { STATUS_LABEL } from "../../util/format.js";
import { reportError } from "../Toasts.js";

export function GroupPanel({ ids, onClose, title }: { ids: string[]; onClose: () => void; title?: string }) {
  const units = useFleet(useShallow((s) => ids.map((i) => s.units[i]).filter((u): u is NonNullable<typeof u> => Boolean(u))));
  const unitTypes = useFleet((s) => s.unitTypes);
  const teams = useFleet((s) => s.teams);
  const toast = useFleet((s) => s.toast);
  const select = useFleet((s) => s.select);
  const [text, setText] = useState("");
  const [queueIfBusy, setQueueIfBusy] = useState(true);
  const [teamName, setTeamName] = useState("");
  const commonTeam = units.length && units.every((u) => u.teamId && u.teamId === units[0]!.teamId) ? teams[units[0]!.teamId!] : undefined;

  const broadcast = async () => {
    const t = text.trim();
    if (!t) return;
    try {
      const r = await api.broadcast({ to: { kind: "units", ids: units.map((u) => u.id) }, text: t, queueIfBusy });
      setText("");
      toast({ kind: "ok", text: `Sent ${r.sent.length}, queued ${r.queued.length}${r.skipped.length ? `, skipped ${r.skipped.length} busy` : ""}.` });
    } catch (err) {
      reportError(err);
    }
  };
  const halt = async () => {
    const busy = units.filter((u) => u.status === "working" || u.status === "waiting");
    await Promise.allSettled(busy.map((u) => api.units.interrupt(u.id)));
    toast({ kind: "ok", text: `Interrupted ${busy.length} unit(s).` });
  };
  const makeTeam = () =>
    api.teams
      .create({ name: teamName.trim(), memberIds: units.map((u) => u.id) })
      .then((t) => {
        setTeamName("");
        toast({ kind: "ok", text: `Team ${t.name} formed.` });
      })
      .catch(reportError);
  const disband = () => commonTeam && api.teams.remove(commonTeam.id).then(() => toast({ kind: "ok", text: `Team ${commonTeam.name} disbanded.` })).catch(reportError);

  return (
    <>
      <header>
        <h2>{title ?? `${units.length} units selected`}</h2>
        <button type="button" className="xbtn" onClick={onClose} aria-label="close">
          ×
        </button>
      </header>
      <div className="body">
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
        <h3 className="sec">Broadcast</h3>
        <textarea className="input" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Order for every selected unit…" />
        <label className="check">
          <input type="checkbox" checked={queueIfBusy} onChange={(e) => setQueueIfBusy(e.target.checked)} /> queue if busy
        </label>
        <div className="row-btns">
          <button type="button" className="btn" onClick={broadcast} disabled={!text.trim()}>
            Broadcast
          </button>
          <button type="button" className="hbtn danger" onClick={halt}>
            Halt selected
          </button>
        </div>
        <h3 className="sec">Team</h3>
        {commonTeam ? (
          <div className="row-btns">
            <span className="chip" style={{ color: commonTeam.color }}>
              {commonTeam.name}
            </span>
            <button type="button" className="hbtn danger" onClick={disband}>
              Disband
            </button>
          </div>
        ) : (
          <div className="row2">
            <input className="input" placeholder="team name" value={teamName} onChange={(e) => setTeamName(e.target.value)} />
            <button type="button" className="hbtn" disabled={!teamName.trim() || units.length < 1} onClick={makeTeam}>
              Group into team
            </button>
          </div>
        )}
      </div>
    </>
  );
}
