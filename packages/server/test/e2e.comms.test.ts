/** FLEET_E2E=1: real units talking through the fleet MCP server. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHub } from "../src/hub.js";
import { silentLog, until } from "./helpers.js";

const E2E = process.env.FLEET_E2E === "1";

describe.skipIf(!E2E)("real SDK comms (FLEET_E2E=1)", () => {
  it(
    "engineer messages infantry via fleet_send; infantry replies in-thread; cross-project denied; general succeeds",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "gridcommander-comms-"));
      const cwd = mkdtempSync(join(tmpdir(), "gridcommander-comms-cwd-"));
      const hub = createHub({ dbPath: join(dir, "fleet.db"), fleetRoot: cwd, maxUnits: 6, doneAutoAckMs: 0, log: silentLog, transcriptBatchMs: 0, watchdogMs: 3_600_000 });
      await hub.boot({ projects: [], teams: [], units: [] }, { autostart: false });
      hub.fleet.createProject({ id: "xre", name: "XRE", cwd, cells: [[0, 0], [1, 0], [2, 0]] });
      hub.fleet.createProject({ id: "web", name: "Web", cwd, cells: [[0, 3], [1, 3]] });
      hub.fleet.createProject({ id: "hq", name: "HQ", cwd, cells: [[-3, 0]] });
      hub.fleet.createUnit({ name: "xre-plan", type: "engineer", projectId: "xre", model: "haiku", permissionMode: "default" });
      hub.fleet.createUnit({ name: "xre-cache", type: "infantry", projectId: "xre", model: "haiku", permissionMode: "default" });
      hub.fleet.createUnit({ name: "general", type: "general", projectId: "hq", model: "haiku", permissionMode: "default" });
      await hub.units.start("xre-plan");
      await hub.units.start("xre-cache");
      await hub.units.start("general");
      // the operator approves every tool permission in this scenario
      hub.units.on("status", (u) => {
        if (u.status !== "waiting" || !u.pendingPermission) return;
        const cmd = String(u.pendingPermission.input.command ?? "");
        const safe = u.pendingPermission.toolName !== "Bash" || /^(git |pwd|ls|echo|cat )/.test(cmd.trim());
        setTimeout(() => hub.units.answerPermission(u.id, { allow: safe, message: safe ? undefined : "Only git/ls/pwd are allowed in this test" }), 50);
      });
      const trace: string[] = [];
      for (const id of ["xre-plan", "xre-cache", "general"]) {
        hub.units.on("status", (u, prev) => u.id === id && trace.push(`${u.name}: ${prev}→${u.status}${u.pendingPermission ? " perm:" + u.pendingPermission.summary : ""}`));
      }
      const dump = () => console.error("TRACE\n" + trace.join("\n") + "\nMSGS " + JSON.stringify(hub.stores.messages.query({ limit: 10 }).map((m) => [m.from, m.to, m.body.slice(0, 60)])));
      const timer = setTimeout(dump, 150_000);

      try {
      const r1 = await hub.units.submit("xre-plan", "Use the fleet_send tool once to ask the unit xre-cache which git branch it is on (ask it to answer in the same thread). Do nothing else; reply 'sent' when done. If a reply arrives later, do not respond to it.", "operator");
      expect(r1.ok).toBe(true);
      const sent = hub.stores.messages.query({ limit: 10 }).find((m) => m.from === "xre-plan");
      expect(sent).toBeTruthy();
      expect(sent!.to).toEqual({ kind: "unit", id: "xre-cache" });
      // the idle infantry receives it as a turn and replies in-thread
      const replyFromCache = () => hub.stores.messages.query({ limit: 20 }).find((m) => m.from === "xre-cache" && m.to.kind === "unit" && m.to.id === "xre-plan");
      await until(() => Boolean(replyFromCache()), 120_000, "reply from xre-cache");
      const reply = replyFromCache()!;
      expect(reply.threadId).toBe(sent!.threadId); // in-thread
      expect(reply.replyTo).toBeTruthy();
      await until(() => hub.fleet.getUnit("xre-cache").status === "done", 60_000, "infantry done");

      // cross-project send from Infantry is denied with the explanatory error; "general" succeeds
      const r2 = await hub.units.submit(
        "xre-cache",
        "First call fleet_send with to='web-ui' and body='hello'. Report the exact error text you get back. Then call fleet_send with to='general' and body='escalation test'. Finally reply with one line summarising both outcomes.",
        "operator",
      );
      expect(r2.ok).toBe(true);
      expect(r2.text.toLowerCase()).toMatch(/general|project|may only|not found/);
      const toGeneral = hub.stores.messages.query({ limit: 20 }).find((m) => m.from === "xre-cache" && m.to.kind === "unit" && m.to.id === "general");
      expect(toGeneral).toBeTruthy();
      } finally {
        clearTimeout(timer);
        dump();
        for (const id of ["xre-plan", "xre-cache", "general"]) {
          console.error("TRANSCRIPT " + id + "\n" + hub.stores.transcript.list(id, { limit: 30 }).map((e) => `  ${e.kind} ${("text" in e ? e.text : "summary" in e ? e.summary : "").slice(0, 160).replace(/\n/g, " ")}`).join("\n"));
        }
        await hub.shutdown();
      }
    },
    300_000,
  );
});
