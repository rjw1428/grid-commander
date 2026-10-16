/**
 * Orders survive the session that was running them: a hub shut down mid-turn (sessions in-process)
 * hands the order back to the queue, and the next boot resumes the unit and resubmits it with the
 * resumed-order note. A unit stopped at a turn boundary has nothing requeued.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESUMED_ORDER_NOTE } from "../src/fleet/OrderService.js";
import { createHub, type Hub } from "../src/hub.js";
import { UnitRuntime } from "../src/runtime/UnitRuntime.js";
import { createFakeSdk, scripts, type FakeTurnScript } from "./fakeSdk.js";
import { silentLog, until } from "./helpers.js";

const dirs: string[] = [];
const hubs: Hub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.shutdown().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function mkHub(dbPath: string, turns: FakeTurnScript[]) {
  const sdk = createFakeSdk({ turns });
  const hub = createHub({
    dbPath,
    fleetRoot: process.cwd(),
    maxUnits: 8,
    doneAutoAckMs: 0,
    log: silentLog,
    transcriptBatchMs: 0,
    watchdogMs: 3_600_000,
    nudgeIntervalMs: 0,
    factory: ({ unit, cwd }) =>
      new UnitRuntime({ unitId: unit.id, cwd, model: unit.model, permissionMode: unit.permissionMode, sessionId: unit.sessionId, systemPromptAppend: "", startGraceMs: 10, interruptTimeoutMs: 500 }, sdk),
  });
  hubs.push(hub);
  return { hub, sdk };
}

describe("order recovery", () => {
  it("requeues the in-flight order on shutdown and resubmits it after reboot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcr-"));
    dirs.push(dir);
    const dbPath = join(dir, "fleet.db");

    const a = mkHub(dbPath, [scripts.interruptible()]);
    await a.hub.boot({ projects: [], teams: [], units: [] }, { autostart: false });
    a.hub.fleet.createProject({ id: "p", name: "P", cwd: process.cwd(), cells: [[0, 0], [1, 0]] });
    a.hub.fleet.createUnit({ id: "u", name: "Unit", type: "sniper", projectId: "p", permissionMode: "default" });
    await a.hub.orders.enqueue("u", "do the thing", "operator");
    await until(() => a.hub.fleet.getUnit("u").status === "working", 2000, "working");
    expect(a.hub.stores.orders.inFlight("u")).toHaveLength(1);
    expect(a.hub.orders.pending("u")).toHaveLength(0);
    const sid = a.hub.fleet.getUnit("u").sessionId;
    expect(sid).toBeTruthy();
    await a.hub.shutdown();

    // the order is back in the queue, not lost
    const b = mkHub(dbPath, [scripts.happy("finished")]);
    expect(b.hub.stores.orders.pending("u")).toHaveLength(1);
    expect(b.hub.stores.orders.inFlight("u")).toHaveLength(0);
    await b.hub.boot({ projects: [], teams: [], units: [] });
    await until(() => b.hub.fleet.getUnit("u").status === "done", 3000, "done after reboot");
    expect(b.sdk.handles[0]!.options.resume).toBe(sid); // resumed, not a new session
    const sent = b.sdk.handles[0]!.received[0]!;
    const text = typeof sent.message.content === "string" ? sent.message.content : JSON.stringify(sent.message.content);
    expect(text.startsWith(RESUMED_ORDER_NOTE)).toBe(true);
    expect(text).toContain("do the thing");
    expect(b.hub.stores.orders.inFlight("u")).toHaveLength(0);
    expect(b.hub.stores.orders.pending("u")).toHaveLength(0);
    expect(b.hub.fleet.getUnit("u").lastResult?.text).toBe("finished");
  });

  it("a unit idle at shutdown has nothing requeued and does not auto-start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcr-"));
    dirs.push(dir);
    const dbPath = join(dir, "fleet.db");
    const a = mkHub(dbPath, [scripts.happy()]);
    await a.hub.boot({ projects: [], teams: [], units: [] }, { autostart: false });
    a.hub.fleet.createProject({ id: "p", name: "P", cwd: process.cwd(), cells: [[0, 0], [1, 0]] });
    a.hub.fleet.createUnit({ id: "u", name: "Unit", type: "sniper", projectId: "p", permissionMode: "default" });
    await a.hub.orders.enqueue("u", "quick", "operator");
    await until(() => a.hub.fleet.getUnit("u").status === "done", 2000, "done");
    expect(a.hub.stores.orders.inFlight("u")).toHaveLength(0); // completed when the turn finished
    await a.hub.shutdown();

    const b = mkHub(dbPath, [scripts.happy()]);
    await b.hub.boot({ projects: [], teams: [], units: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.hub.fleet.getUnit("u").status).toBe("offline");
    expect(b.hub.units.runningCount).toBe(0);
    expect(b.hub.orders.pending("u")).toHaveLength(0);
  });

  it("a session that dies mid-turn at runtime fails the turn and closes the order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcr-"));
    dirs.push(dir);
    const a = mkHub(join(dir, "fleet.db"), [scripts.crash()]);
    await a.hub.boot({ projects: [], teams: [], units: [] }, { autostart: false });
    a.hub.fleet.createProject({ id: "p", name: "P", cwd: process.cwd(), cells: [[0, 0], [1, 0]] });
    a.hub.fleet.createUnit({ id: "u", name: "Unit", type: "sniper", projectId: "p", permissionMode: "default" });
    await a.hub.orders.enqueue("u", "boom", "operator");
    // the fake crashes inside start()'s grace window, so the unit ends offline or error; either way the order is settled
    await until(() => ["error", "offline"].includes(a.hub.fleet.getUnit("u").status) && a.sdk.handles[0]?.received.length === 1, 2000, "crashed");
    expect(a.hub.stores.orders.inFlight("u")).toHaveLength(0);
    expect(a.hub.orders.pending("u")).toHaveLength(0);
  });
});
