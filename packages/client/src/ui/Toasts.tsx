import { useFleet } from "../store/useFleet.js";

export function Toasts() {
  const toasts = useFleet((s) => s.toasts);
  const dismiss = useFleet((s) => s.dismissToast);
  if (!toasts.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} type="button" className={`toast ${t.kind}`} onClick={() => dismiss(t.id)}>
          {t.text}
        </button>
      ))}
    </div>
  );
}

export function reportError(err: unknown, fallback = "Request failed"): void {
  const msg = err instanceof Error ? err.message : fallback;
  useFleet.getState().toast({ kind: "error", text: msg });
}
