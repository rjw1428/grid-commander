import { useEffect, useState } from "react";
import type { Order, Unit } from "@gridcommander/shared";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { reportError } from "../Toasts.js";

export function PermissionCard({ unit }: { unit: Unit }) {
  const req = unit.pendingPermission;
  const [remember, setRemember] = useState(false);
  if (!req) return null;
  const answer = (allow: boolean) => api.units.permission(unit.id, { allow, remember: allow && remember }).catch(reportError);
  const inputText = JSON.stringify(req.input, null, 1).slice(0, 600);
  return (
    <div className="card waiting">
      <div className="card-title">Permission: {req.toolName}</div>
      <div className="mono card-sum">{req.summary}</div>
      <details>
        <summary className="hint">input</summary>
        <pre className="mono small">{inputText}</pre>
      </details>
      <label className="check">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} /> always allow this
      </label>
      <div className="row-btns">
        <button type="button" className="btn" onClick={() => answer(true)}>
          Approve
        </button>
        <button type="button" className="btn danger" onClick={() => answer(false)}>
          Deny
        </button>
      </div>
    </div>
  );
}

export function QuestionCard({ unit }: { unit: Unit }) {
  const q = unit.pendingQuestion;
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers({}), [q?.toolUseId]);
  if (!q) return null;
  const complete = q.questions.every((qq) => answers[qq.question]);
  return (
    <div className="card waiting">
      <div className="card-title">Question</div>
      {q.questions.map((qq) => (
        <div key={qq.question} className="q">
          <div className="q-text">
            {qq.header && <span className="chip">{qq.header}</span>} {qq.question}
          </div>
          <div className="q-opts">
            {qq.options.map((o) => {
              const sel = qq.multiSelect ? (answers[qq.question] ?? "").split(", ").includes(o.label) : answers[qq.question] === o.label;
              return (
                <button
                  key={o.label}
                  type="button"
                  className={`opt${sel ? " sel" : ""}`}
                  onClick={() =>
                    setAnswers((a) => {
                      if (!qq.multiSelect) return { ...a, [qq.question]: o.label };
                      const cur = (a[qq.question] ?? "").split(", ").filter(Boolean);
                      const next = cur.includes(o.label) ? cur.filter((x) => x !== o.label) : [...cur, o.label];
                      return { ...a, [qq.question]: next.join(", ") };
                    })
                  }
                >
                  <b>{o.label}</b>
                  {o.description && <span>{o.description}</span>}
                </button>
              );
            })}
          </div>
          <input className="input" placeholder="or type an answer" value={answers[qq.question] ?? ""} onChange={(e) => setAnswers((a) => ({ ...a, [qq.question]: e.target.value }))} />
        </div>
      ))}
      <button type="button" className="btn" disabled={!complete} onClick={() => api.units.answer(unit.id, answers).catch(reportError)}>
        Answer
      </button>
    </div>
  );
}

export function Orders({ unit }: { unit: Unit }) {
  const [text, setText] = useState("");
  const [queue, setQueue] = useState<Order[]>([]);
  const busy = unit.status === "working" || unit.status === "waiting";
  const toast = useFleet((s) => s.toast);

  useEffect(() => {
    let live = true;
    const load = () => api.units.orders(unit.id).then((o) => live && setQueue(o)).catch(() => {});
    load();
    return () => {
      live = false;
    };
  }, [unit.id, unit.queueLength]);

  const send = async (interrupt = false) => {
    const t = text.trim();
    if (!t) return;
    try {
      const r = await api.units.order(unit.id, { text: t, interrupt });
      setText("");
      toast({ kind: "ok", text: r.queued ? `Queued for ${unit.name}.` : `Sent to ${unit.name}.` });
    } catch (err) {
      reportError(err);
    }
  };
  const act = (fn: () => Promise<unknown>) => () => fn().catch(reportError);

  return (
    <div className="orders">
      <PermissionCard unit={unit} />
      <QuestionCard unit={unit} />
      <textarea
        className="input"
        rows={3}
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? "Queue the next order… (⌘/Ctrl+Enter to queue)" : "Give an order… (⌘/Ctrl+Enter to send)"}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void send(false);
        }}
      />
      <div className="row-btns">
        {busy ? (
          <>
            <button type="button" className="btn" onClick={() => send(false)} disabled={!text.trim()}>
              Queue
            </button>
            <button type="button" className="btn warn" onClick={() => send(true)} disabled={!text.trim()}>
              Interrupt & send
            </button>
          </>
        ) : (
          <button type="button" className="btn" onClick={() => send(false)} disabled={!text.trim()}>
            {unit.status === "offline" ? "Start & send" : "Send"}
          </button>
        )}
      </div>
      {queue.length > 0 && (
        <div className="queue">
          <h3 className="sec">Queued ({queue.length})</h3>
          {queue.map((o, i) => (
            <div key={o.id} className="queued">
              <span className="mono hint">{i + 1}</span>
              <span className="queued-text">{o.text}</span>
              <button type="button" className="xbtn" aria-label="remove" onClick={act(() => api.units.removeOrder(unit.id, o.id))}>
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="quick">
        {busy && (
          <button type="button" className="hbtn" onClick={act(() => api.units.interrupt(unit.id))} title="Esc">
            Interrupt
          </button>
        )}
        {(unit.status === "done" || unit.status === "error") && (
          <button type="button" className="hbtn" onClick={act(() => api.units.ack(unit.id))}>
            Ack
          </button>
        )}
        {unit.status !== "offline" && (
          <button type="button" className="hbtn" onClick={act(() => api.units.compact(unit.id))}>
            /compact
          </button>
        )}
        {unit.status === "offline" ? (
          <button type="button" className="hbtn" onClick={act(() => api.units.start(unit.id))}>
            Start
          </button>
        ) : (
          <button type="button" className="hbtn" onClick={act(() => api.units.stop(unit.id))}>
            Stop
          </button>
        )}
      </div>
      {unit.lastResult && (
        <div className="card">
          <div className="card-title">
            Last result <span className="hint">{unit.lastResult.ok === false ? "error" : ""}</span>
          </div>
          <pre className="small">{unit.lastResult.text.slice(0, 2000)}</pre>
        </div>
      )}
    </div>
  );
}
