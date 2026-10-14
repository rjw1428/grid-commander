import { hexKey, hexNeighbors, type Hex, type Project } from "@gridcommander/shared";

/**
 * Hexes the project could grow into: free neighbours of its own cells that are not
 * adjacent to another project's territory (keeps one hex of water between projects,
 * matching the server's auto-allocation rule).
 */
export function growthCandidates(project: Project, projects: Project[]): Hex[] {
  const own = new Set(project.cells.map(hexKey));
  const foreign = new Set<string>();
  for (const p of projects) if (p.id !== project.id) for (const c of p.cells) foreign.add(hexKey(c));
  const out = new Map<string, Hex>();
  for (const c of project.cells) {
    for (const n of hexNeighbors(c)) {
      const k = hexKey(n);
      if (own.has(k) || foreign.has(k) || out.has(k)) continue;
      if (hexNeighbors(n).some((m) => foreign.has(hexKey(m)))) continue;
      out.set(k, n);
    }
  }
  return [...out.values()];
}

/** Why a cell cannot be removed from a territory, or null when it can. */
export function removeBlocker(project: Project, hex: Hex, units: { hex: Hex; projectId: string; name: string }[]): string | null {
  if (project.cells.length <= 1) return "A project needs at least one hex.";
  const u = units.find((x) => x.projectId === project.id && hexKey(x.hex) === hexKey(hex));
  if (u) return `${u.name} is standing on that hex.`;
  return null;
}
