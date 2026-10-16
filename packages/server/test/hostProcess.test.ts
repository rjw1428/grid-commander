/**
 * The real detached host process (demo runtime): the hub spawns it, a unit survives the hub
 * disconnecting and a fresh hub re-attaches to it, and a hub-level boot adopts it. Finally the host
 * is told to shut down and its pid file disappears.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { FleetConfigSchema } from "@gridcommander/shared";
import { HostClient } from "../src/host/HostClient.js";
import { RemoteRuntime } from "../src/host/RemoteRuntime.js";
import { createHub, type Hub } from "../src/hub.js";
import { silentLog, until } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const serverRoot = resolve(here, "..");
const tsx = resolve(serverRoot, "node_modules/tsx/dist/cli.mjs");
const entry = resolve(serverRoot, "src/host/index.ts");

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function env(dir: string, socketPath: string) {
  const pidFile = join(dir, "host.pid");
  return {
    socketPath,
    pidFile,
    spawn: {
      command: process.execPath,
      args: [tsx, entry],
      cwd: serverRoot,
      env: { ...process.env, FLEET_HOST_SOCKET: socketPath, FLEET_HOST_PID: pidFile, FLEET_DEMO: "1", LOG_LEVEL: "warn", FLEET_HOST_IDLE_EXIT_MS: "0" },
      logFile: join(dir, "host.log"),
      pidFile,
    },
  };
}

const bridge = async () => undefined;

describe.skipIf(!existsSync(tsx))("unit host process (demo runtime)", () => {
  it("spawns, survives hub detach, is adopted by a hub boot, and shuts down on request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gcp-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const socketPath = join(dir, "h.sock");
    const o = env(dir, socketPath);
    // never leave a host behind, whatever happens below
    cleanups.push(() => {
      if (!existsSync(o.pidFile)) return;
      try {
        process.kill(Number(readFileSync(o.pidFile, "utf8").trim()), "SIGKILL");
      } catch {
        /* gone */
      }
    });

    const c1 = new HostClient({ socketPath, spawn: o.spawn, log: silentLog, hubVersion: "test", bridge, connectTimeoutMs: 20_000 });
    const hello1 = await c1.connect();
    expect(hello1.units).toEqual([]);
    expect(c1.spawnedPid).toBeTruthy();
    await until(() => existsSync(o.pidFile), 3000, "pid file");

    const rt = new RemoteRuntime(c1, { unitId: "demo-1", name: "Demo", cwd: dir, model: "sonnet", permissionMode: "default", systemPromptAppend: "", fleetTools: [], nudgeHook: false }, silentLog);
    await rt.start();
    await until(() => rt.status === "idle", 5000, "idle");
    const turn = rt.submit("take your time with this long task", "operator");
    await until(() => rt.status === "working", 5000, "working");
    c1.disconnect();
    expect((await turn).ok).toBe(false); // this hub's view of the turn ends; the session does not

    // a hub boot on an empty DB with the same unit adopts the running session
    const hub: Hub = createHub({
      dbPath: join(dir, "fleet.db"),
      fleetRoot: dir,
      maxUnits: 4,
      doneAutoAckMs: 0,
      log: silentLog,
      transcriptBatchMs: 0,
      watchdogMs: 3_600_000,
      nudgeIntervalMs: 0,
      host: { socketPath, spawn: o.spawn, connectTimeoutMs: 20_000 },
    });
    cleanups.push(() => hub.shutdown());
    await hub.boot(
      FleetConfigSchema.parse({
        projects: [{ id: "p", name: "P", cwd: dir, tint: "#223344", flag: "#aabbcc", cells: [[0, 0], [1, 0]] }],
        teams: [],
        units: [{ id: "demo-1", name: "Demo", type: "sniper", projectId: "p", permissionMode: "default", hex: [0, 0] }],
      }),
      { autostart: false },
    );
    expect(hub.host?.connected).toBe(true);
    expect(hub.host?.hostInfo?.pid).toBe(hello1.pid);
    expect(hub.units.runningCount).toBe(1);
    const u = hub.fleet.getUnit("demo-1");
    expect(["working", "waiting", "done", "idle"]).toContain(u.status);
    // the demo turn finishes on its own and the adopted runtime delivers the result
    await until(() => hub.fleet.getUnit("demo-1").lastResult !== undefined, 30_000, "demo turn finished");
    expect(hub.fleet.getUnit("demo-1").lastResult?.text).toContain("long task finished");
    expect(hub.fleet.getUnit("demo-1").status).toBe("done");

    // detach keeps the session; a request to shut down stops it and the process goes away
    await hub.units.stop("demo-1");
    const c3 = hub.host!;
    await c3.request({ type: "shutdown", id: "sd" }, 20_000);
    await until(() => !existsSync(o.pidFile), 10_000, "pid file removed");
    await until(() => {
      try {
        process.kill(hello1.pid, 0);
        return false;
      } catch {
        return true;
      }
    }, 10_000, "host exited");
  }, 60_000);
});
