import { useEffect, useRef, useState } from "react";
import type { TranscriptEntry } from "@gridcommander/shared";
import { api } from "../../api/client.js";
import { useFleet } from "../../store/useFleet.js";
import { reportError } from "../Toasts.js";

const WINDOW = 120;

function Entry({ e }: { e: TranscriptEntry }) {
  switch (e.kind) {
    case "user":
      return (
        <div className={`te user ${e.source}`}>
          <span className="te-k">{e.source === "operator" ? "order" : e.source}</span>
          <pre>{e.text}</pre>
        </div>
      );
    case "assistant":
      return (
        <div className="te assistant">
          <pre>{e.text}</pre>
        </div>
      );
    case "tool":
      return (
        <div className={`te tool${e.ok === false ? " fail" : e.ok ? " ok" : ""}`}>
          <span className="te-dot" />
          <span className="te-sum">{e.summary}</span>
          {e.durationMs !== undefined && <span className="te-ms">{e.durationMs < 1000 ? `${e.durationMs}ms` : `${(e.durationMs / 1000).toFixed(1)}s`}</span>}
          {e.ok === false && <span className="te-ms">failed</span>}
        </div>
      );
    case "result":
      return (
        <div className={`te result ${e.ok ? "ok" : "fail"}`}>
          <span className="te-k">
            {e.ok ? "result" : "error"}
            {e.costUsd !== undefined && ` · $${e.costUsd.toFixed(3)}`}
          </span>
          <pre>{e.text}</pre>
        </div>
      );
    case "message":
      return (
        <div className={`te message ${e.direction}`}>
          <span className="te-k">{e.direction === "in" ? "message in" : "message out"}</span>
          <pre>{e.text ?? e.messageId}</pre>
        </div>
      );
    case "system":
      return <div className="te system">{e.text}</div>;
  }
}

/** Windowed transcript: the newest WINDOW entries render; "earlier" widens the window, then fetches. */
export function Transcript({ unitId }: { unitId: string }) {
  const entries = useFleet((s) => s.transcripts[unitId]);
  const setTranscript = useFleet((s) => s.setTranscript);
  const prepend = useFleet((s) => s.prependTranscript);
  const [win, setWin] = useState(WINDOW);
  const [loading, setLoading] = useState(false);
  const [exhausted, setExhausted] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setWin(WINDOW);
    setExhausted(false);
    stick.current = true;
    let cancelled = false;
    setLoading(true);
    api.units
      .transcript(unitId, { limit: 200 })
      .then((r) => {
        if (!cancelled) setTranscript(unitId, r.entries);
      })
      .catch(reportError)
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [unitId, setTranscript]);

  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [entries, win]);

  const onScroll = () => {
    const el = box.current;
    if (!el) return;
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const earlier = async () => {
    const all = entries ?? [];
    if (win < all.length) {
      stick.current = false;
      setWin((w) => w + WINDOW);
      return;
    }
    const first = all[0];
    if (!first) return;
    setLoading(true);
    try {
      const r = await api.units.transcript(unitId, { before: first.at, limit: 200 });
      if (!r.entries.length) setExhausted(true);
      else {
        stick.current = false;
        prepend(unitId, r.entries);
        setWin((w) => w + r.entries.length);
      }
    } catch (err) {
      reportError(err);
    } finally {
      setLoading(false);
    }
  };

  const all = entries ?? [];
  const shown = all.slice(Math.max(0, all.length - win));
  return (
    <div className="transcript" ref={box} onScroll={onScroll}>
      {!exhausted && (all.length > 0 || loading) && (
        <button type="button" className="hbtn small" onClick={earlier} disabled={loading}>
          {loading ? "Loading…" : "Load earlier"}
        </button>
      )}
      {all.length === 0 && !loading && <div className="empty">No transcript yet.</div>}
      {shown.map((e, i) => (
        <Entry key={`${e.at}-${i}`} e={e} />
      ))}
    </div>
  );
}
