/**
 * Hub-level recovery when the unit host goes away: a graceful host shutdown (announced with
 * `closing`) and an abrupt loss both end with the host back, the unit resumed by sessionId and the
 * interrupted order resubmitted with the resumed-order note.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RESUMED_ORDER_NOTE } from "../src/fleet/OrderService.js";
import { sdkHostFactory } from "../src/host/factories.js";
import { HostServer } from "../src/host/HostServer.js";
import { createHub, type Hub } from "../src/hub.js";
import { createFakeSdk, scripts, type FakeTurnScript } from "./fakeSdk.js";
import { silentLog, until } from "./helpers.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function startHost(socketPath: string, turns: FakeTurnScript[]) {
  const sdk = createFakeSdk({ turns });
  const host = new HostServer({ socketPath, factory: sdkHostFactory(silentLog, sdk), log: silentLog, version: "test" });
  await host.listen();
  cleanups.push(() => host.close());
  return { sdk, host };
}

function mkHub(dir: string, socketPath: string): Hub {
  const hub = createHub({
    dbPath: join(dir, "fleet.db"),
    fleetRoot: dir,
    maxUnits: 4,
    doneAutoAckMs: 0,
    log: silentLog,
    transcriptBatchMs: 0,
    watchdogMs: 3_600_000,
    nudgeIntervalMs: 0,
    host: { socketPath, connectTimeoutMs: 300, reconnectDelayMs: 50 },
  });
  cleanups.push(() => hub.shutdown());
  return hub;
}

async function recruit(hub: Hub, dir: string) {
  await hub.boot({ projects: [], teams: [], units: [] }, { autostart: false });
  hub.fleet.createProject({ id: "p", name: "P", cwd: dir, cells: [[0, 0], [1, 0]] });
  hub.fleet.createUnit({ id: "u", name: "Unit", type: "sniper", projectId: "p", permissionMode: "default" });
  await hub.orders.enqueue("u", "long job", "operator");
  await until(() => hub.fleet.getUnit("u").status === "working", 3000, "working");
  expect(hub.stores.orders.inFlight("u")).toHaveLength(1);
  return hub.fleet.getUnit("u").sessionId!;
}

async function expectRecovered(hub: Hub, sdk2: ReturnType<typeof createFakeSdk>, sid: string) {
  await until(() => hub.fleet.getUnit("u").status === "done", 5000, "done after recovery");
  expect(sdk2.handles).toHaveLength(1);
  expect(sdk2.handles[0]!.options.resume).toBe(sid);
  const sent = sdk2.handles[0]!.received[0]!;
  const text = typeof sent.message.content === "string" ? sent.message.content : JSON.stringify(sent.message.content);
  expect(text.startsWith(RESUMED_ORDER_NOTE)).toBe(true);
  expect(text).toContain("long job");
  expect(hub.stores.orders.inFlight("u")).toHaveLength(0);
  expect(hub.orders.pending("u")).toHaveLength(0);
  expect(hub.fleet.getUnit("u").lastResult?.text).toBe("after recovery");
  expect(hub.alerts.list().some((a) => a.title === "Unit host disconnected")).toBe(true);
}

describe("unit host loss", () => {
  it("graceful host shutdown: the hub requeues the order, relaunches and resumes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gchr-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "h.sock");
    const h1 = await startHost(socketPath, [scripts.interruptible()]);
    const hub = mkHub(dir, socketPath);
    const sid = await recruit(hub, dir);

    await h1.host.close(); // SIGTERM path: announces closing, stops units, closes the socket
    await until(() => hub.fleet.getUnit("u").status === "offline", 2000, "offline after host close");
    // the order is back in the queue, waiting for a host
    await until(() => hub.orders.pending("u").length === 1, 2000, "requeued");
    expect(hub.stores.orders.inFlight("u")).toHaveLength(0);

    const h2 = await startHost(socketPath, [scripts.happy("after recovery")]);
    await expectRecovered(hub, h2.sdk, sid);
  });

  it("abrupt host loss: same outcome without the closing notice", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gchr-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "h.sock");
    const h1 = await startHost(socketPath, [scripts.interruptible()]);
    const hub = mkHub(dir, socketPath);
    const sid = await recruit(hub, dir);

    // a killed host process: the socket just closes, no `closing` notice, no unit exit events
    h1.host.dropHub();
    await h1.host.close({ announce: false });
    await until(() => hub.orders.pending("u").length === 1, 3000, "requeued");
    expect(hub.stores.orders.inFlight("u")).toHaveLength(0);

    const h2 = await startHost(socketPath, [scripts.happy("after recovery")]);
    await expectRecovered(hub, h2.sdk, sid);
  });
});
