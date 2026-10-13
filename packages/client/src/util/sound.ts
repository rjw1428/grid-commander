import type { AlertKind } from "@hexcommand/shared";

let ctx: AudioContext | null = null;

/** Must be called from a user gesture once; browsers block audio otherwise. */
export function enableSound(): boolean {
  try {
    ctx = ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    void ctx.resume();
    return true;
  } catch {
    return false;
  }
}

const FREQ: Partial<Record<AlertKind, number>> = { waiting: 660, error: 220, done: 880, message: 740 };

export function beep(kind: AlertKind): void {
  const f = FREQ[kind];
  if (!ctx || !f) return;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "triangle";
  osc.frequency.value = f;
  gain.gain.value = 0.0001;
  osc.connect(gain).connect(ctx.destination);
  const t = ctx.currentTime;
  gain.gain.exponentialRampToValueAtTime(0.18, t + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t + (kind === "error" ? 0.5 : 0.25));
  osc.start(t);
  osc.stop(t + 0.55);
}
