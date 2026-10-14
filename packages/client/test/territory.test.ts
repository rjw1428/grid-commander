import { describe, expect, it } from "vitest";
import type { Project } from "@gridcommander/shared";
import { growthCandidates, removeBlocker } from "../src/util/territory.js";

const proj = (id: string, cells: [number, number][]): Project => ({ id, name: id, cwd: "", tint: "#000", flag: "#fff", cells });

describe("territory helpers", () => {
  it("offers free neighbours and keeps a water gap from other projects", () => {
    const a = proj("a", [[0, 0]]);
    const alone = growthCandidates(a, [a]);
    expect(alone.length).toBe(6);
    // project b two hexes to the right: (2,0). Its neighbour (1,0) is adjacent to b → excluded.
    const b = proj("b", [[2, 0]]);
    const near = growthCandidates(a, [a, b]);
    expect(near.map(String)).not.toContain("1,0");
    expect(near.length).toBeLessThan(6);
    // never offers a hex a project already owns
    const big = proj("a", [[0, 0], [1, 0]]);
    expect(growthCandidates(big, [big]).map(String)).not.toContain("1,0");
  });

  it("blocks removing the last hex or an occupied one", () => {
    const a = proj("a", [[0, 0], [1, 0]]);
    expect(removeBlocker(a, [1, 0], [])).toBeNull();
    expect(removeBlocker(a, [1, 0], [{ hex: [1, 0], projectId: "a", name: "scout" }])).toMatch(/scout/);
    expect(removeBlocker(proj("a", [[0, 0]]), [0, 0], [])).toMatch(/at least one/);
  });
});
