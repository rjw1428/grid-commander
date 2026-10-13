import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FleetConfigSchema } from "@gridcommander/shared";
import { hexSpiral } from "../src/fleet/FleetService.js";
import { createTestHub, exampleFleet, until } from "./helpers.js";

describe("FleetService", () => {
  it("loads fleet.example.json: structure from config, runtime fields from DB", async () => {
    const t = createTestHub();
    await t.hub.boot(exampleFleet(), { autostart: false });
    expect(t.hub.fleet.projects.size).toBe(4);
    expect(t.hub.fleet.units.size).toBe(14);
    expect(t.hub.fleet.getUnit("xre-plan")).toMatchObject({ status: "offline", model: "opus", permissionMode: "acceptEdits", teamId: "t1" });
    // DB wins for sessionId on reload
    t.hub.fleet.updateUnit("xre-plan", { sessionId: "sess-123", status: "working" });
    const again = createTestHub({ hub: { dbPath: ":memory:" } });
    void again; // separate DB; emulate reload on same stores instead:
    const { wasWorking } = t.hub.fleet.load(exampleFleet());
    expect(t.hub.fleet.getUnit("xre-plan").sessionId).toBe("sess-123");
    expect(t.hub.fleet.getUnit("xre-plan").status).toBe("offline");
    expect(wasWorking.map((u) => u.id)).toEqual(["xre-plan"]);
  });

  it("allocates the first free hex and rejects occupied / outside hexes", async () => {
    const t = createTestHub();
    await t.hub.boot(exampleFleet(), { autostart: false });
    const u = t.hub.fleet.createUnit({ name: "xre-new", type: "infantry", projectId: "xre" });
    expect(u.hex).toEqual([2, 1]); // first cell not yet occupied in xre
    expect(() => t.hub.fleet.createUnit({ name: "dup", type: "infantry", projectId: "xre", hex: [0, 0] })).toThrow(/occupied/);
    expect(() => t.hub.fleet.createUnit({ name: "out", type: "infantry", projectId: "xre", hex: [9, 9] })).toThrow(/not in project/);
    expect(() => t.hub.fleet.createUnit({ name: "xre-new", type: "infantry", projectId: "xre" })).toThrow(/already exists/);
    expect(() => t.hub.fleet.createUnit({ name: "x", type: "wizard", projectId: "xre" })).toThrow(/unknown unit type/);
  });

  it("moves units across projects and keeps team membership consistent", async () => {
    const t = createTestHub();
    await t.hub.boot(exampleFleet(), { autostart: false });
    const moved = t.hub.fleet.patchUnit("xre-scout", { projectId: "web" });
    expect(moved.projectId).toBe("web");
    expect(t.hub.fleet.getProject("web").cells.map(String)).toContain(String(moved.hex));
    const team = t.hub.fleet.createTeam({ name: "Strike", memberIds: ["xre-scout", "web-ui"] });
    expect(t.hub.fleet.getUnit("web-ui").teamId).toBe(team.id);
    t.hub.fleet.patchTeam(team.id, { memberIds: ["web-ui"] });
    expect(t.hub.fleet.getUnit("xre-scout").teamId).toBeUndefined();
    t.hub.fleet.deleteTeam(team.id);
    expect(t.hub.fleet.getUnit("web-ui").teamId).toBeUndefined();
    // joining a second team leaves the first
    t.hub.fleet.patchUnit("xre-cache", { teamId: null });
    expect(t.hub.fleet.getTeam("t1").memberIds).not.toContain("xre-cache");
  });

  it("creates projects with an auto-allocated territory that does not overlap", async () => {
    const t = createTestHub();
    await t.hub.boot(exampleFleet(), { autostart: false });
    const p = t.hub.fleet.createProject({ name: "New Thing", cwd: "/tmp/x" });
    expect(p.id).toBe("new-thing");
    expect(p.cells.length).toBe(7);
    const taken = new Set([...t.hub.fleet.projects.values()].filter((q) => q.id !== p.id).flatMap((q) => q.cells.map(String)));
    for (const c of p.cells) expect(taken.has(String(c))).toBe(false);
    expect(() => t.hub.fleet.deleteProject("xre")).toThrow(/unit/);
    expect(() => t.hub.fleet.patchProject("xre", { cells: [[0, 0]] })).toThrow(/occupied/);
    expect(() => t.hub.fleet.createProject({ name: "Clash", cwd: "/tmp", cells: [[0, 0]] })).toThrow(/another project/);
    t.hub.fleet.deleteProject(p.id);
    expect(t.hub.fleet.projects.has(p.id)).toBe(false);
  });

  it("writes fleet.json back atomically and the result re-validates", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gridcommander-fleet-"));
    const path = join(dir, "fleet.json");
    const t = createTestHub({ configPath: path });
    await t.hub.boot(exampleFleet(), { autostart: false });
    t.hub.fleet.createUnit({ name: "wb-unit", type: "sniper", projectId: "web", task: "look around" });
    t.hub.fleet.flush();
    await until(() => existsSync(path), 1000, "fleet.json");
    const cfg = FleetConfigSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    expect(cfg.units.find((u) => u.id === "wb-unit")).toMatchObject({ type: "sniper", projectId: "web", task: "look around", autostart: false });
    expect(cfg.projects.length).toBe(4);
  });

  it("hexSpiral yields distinct hexes ring by ring", () => {
    const s = hexSpiral(3);
    expect(s.length).toBe(1 + 6 + 12 + 18);
    expect(new Set(s.map(String)).size).toBe(s.length);
  });
});
