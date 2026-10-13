/**
 * FLEET_E2E=1: start a real unit, stop the hub, boot a second hub on the same DB and verify the
 * session resumes with the same session id and remembers context.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHub } from "../src/hub.js";
import { silentLog, until } from "./helpers.js";

const E2E = process.env.FLEET_E2E === "1";

describe.skipIf(!E2E)("real SDK resume (FLEET_E2E=1)", () => {
  it(
    "unit resumes by sessionId after a server restart",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "hexcommand-resume-"));
      const dbPath = join(dir, "fleet.db");
      const configPath = join(dir, "fleet.json");
      const cwd = mkdtempSync(join(tmpdir(), "hexcommand-resume-cwd-"));
      const mk = () =>
        createHub({ dbPath, configPath, fleetRoot: cwd, maxUnits: 4, doneAutoAckMs: 0, log: silentLog, transcriptBatchMs: 0, watchdogMs: 3_600_000 });

      const hub1 = mk();
      await hub1.boot({ projects: [], teams: [], units: [] }, { autostart: false });
      hub1.fleet.createProject({ id: "p", name: "P", cwd, cells: [[0, 0], [1, 0]] });
      hub1.fleet.createUnit({ name: "memo", type: "sniper", projectId: "p", permissionMode: "default" });
      hub1.fleet.patchUnit("memo", { autostart: true });
      await hub1.units.start("memo");
      const r1 = await hub1.units.submit("memo", "The secret word is pineapple. Reply only with: noted", "operator");
      expect(r1.ok).toBe(true);
      const sid = hub1.fleet.getUnit("memo").sessionId;
      expect(sid).toBeTruthy();
      await hub1.shutdown();

      const hub2 = mk();
      await hub2.boot(JSON.parse((await import("node:fs")).readFileSync(configPath, "utf8")));
      await until(() => hub2.fleet.getUnit("memo").status === "idle", 10_000, "autostart idle");
      expect(hub2.fleet.getUnit("memo").sessionId).toBe(sid);
      const r2 = await hub2.units.submit("memo", "What was the secret word? Reply with just the word.", "operator");
      expect(r2.ok).toBe(true);
      expect(r2.text.toLowerCase()).toContain("pineapple");
      expect(hub2.fleet.getUnit("memo").sessionId).toBe(sid);
      await hub2.shutdown();
    },
    240_000,
  );
});
