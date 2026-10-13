import type { Unit } from "@hexcommand/shared";

/** Units that need the operator, most urgent first: waiting, then error, then done. */
export function attentionQueue(units: Unit[]): Unit[] {
  const rank: Record<string, number> = { waiting: 0, error: 1, done: 2 };
  return units
    .filter((u) => u.status in rank)
    .sort((a, b) => rank[a.status]! - rank[b.status]! || a.statusSince - b.statusSince);
}

/** The next unit after `currentId` in the attention queue (wraps). */
export function nextAttention(units: Unit[], currentId: string | null): Unit | undefined {
  const q = attentionQueue(units);
  if (!q.length) return undefined;
  const idx = currentId ? q.findIndex((u) => u.id === currentId) : -1;
  return q[(idx + 1) % q.length];
}
