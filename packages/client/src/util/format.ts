export function ago(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}

export function minutesSince(ms: number, now = Date.now()): number {
  return Math.floor((now - ms) / 60_000);
}

export function shortModel(model: string): string {
  const m = /(opus|sonnet|haiku)/i.exec(model);
  return m ? m[1]!.toLowerCase() : model;
}

export function firstLine(s: string | undefined, max = 120): string {
  const l = (s ?? "").split("\n").find((x) => x.trim()) ?? "";
  return l.length > max ? l.slice(0, max - 1) + "…" : l;
}

export const STATUS_LABEL: Record<string, string> = {
  offline: "Offline",
  idle: "Idle",
  working: "Working",
  waiting: "Awaiting input",
  done: "Done",
  error: "Error",
};
