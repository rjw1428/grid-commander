/**
 * Unit host protocol: HostServer + HostClient over a real Unix socket in one process, with the fake
 * SDK behind UnitRuntime. Covers start/submit/result, bridged fleet tools, buffering while no hub is
 * attached, and re-attaching a second hub to a session the first one left behind.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TranscriptEntry } from "@gridcommander/shared";
import { sdkHostFactory } from "../src/host/factories.js";
import { HostClient, type BridgeHandler } from "../src/host/HostClient.js";
import { HostServer } from "../src/host/HostServer.js";
import { RemoteRuntime } from "../src/host/RemoteRuntime.js";
import type { UnitSpec } from "../src/host/protocol.js";
import { createFakeSdk, scripts, type FakeQueryHandle, type FakeTurnScript } from "./fakeSdk.js";
import { silentLog, until } from "./helpers.js";

type FakeTool = { name: string; handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
const toolsOf = (h: FakeQueryHandle): FakeTool[] =>
  ((h.options.mcpServers?.fleet as unknown as { instance: { __fakeTools: FakeTool[] } })?.instance.__fakeTools ?? []) as FakeTool[];

const spec = (unitId: string, extra: Partial<UnitSpec> = {}): UnitSpec => ({
  unitId,
  name: unitId,
  cwd: process.cwd(),
  model: "sonnet",
  permissionMode: "default",
  systemPromptAppend: "",
  fleetTools: ["fleet_report"],
  nudgeHook: true,
  ...extra,
});

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

async function setup(turns: FakeTurnScript[] = [scripts.happy()], bridge?: BridgeHandler) {
  // short socket path: macOS caps sun_path at 104 bytes
  const dir = mkdtempSync(join(tmpdir(), "gch-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const socketPath = join(dir, "h.sock");
  const sdk = createFakeSdk({ turns });
  const host = new HostServer({
    socketPath,
    factory: (s, b) => {
      const rt = sdkHostFactory(silentLog, sdk)(s, b);
      return rt;
    },
    log: silentLog,
    version: "test",
    bridgeTimeoutMs: 2000,
  });
  await host.listen();
  cleanups.push(() => host.close());
  const bridgeCalls: { unitId: string; kind: string; name: string; args: Record<string, unknown> }[] = [];
  const mkClient = () =>
    new HostClient({
      socketPath,
      log: silentLog,
      hubVersion: "test",
      bridge:
        bridge ??
        (async (unitId, kind, name, args) => {
          bridgeCalls.push({ unitId, kind, name, args });
          if (kind === "nudge") return undefined;
          return { content: [{ type: "text", text: `bridged:${name}` }] };
        }),
    });
  return { socketPath, sdk, host, mkClient, bridgeCalls };
}

describe("unit host protocol", () => {
  it("starts a unit, runs a turn and streams its events to the hub", async () => {
    const { sdk, mkClient } = await setup([scripts.happy("done")]);
    const client = mkClient();
    const hello = await client.connect();
    expect(hello.units).toEqual([]);
    cleanups.push(() => client.disconnect());

    const rt = new RemoteRuntime(client, spec("u1"), silentLog);
    const statuses: string[] = [];
    const transcript: TranscriptEntry[] = [];
    rt.on("status", (s) => statuses.push(s));
    rt.on("transcript", (e) => transcript.push(...e));
    await rt.start();
    expect(sdk.handles).toHaveLength(1);
    const r = await rt.submit("go", "operator");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("done");
    await until(() => statuses.includes("done"), 2000, "done status");
    expect(transcript.some((e) => e.kind === "user" && e.text === "go")).toBe(true);
    expect(rt.sessionId).toBeTruthy();
    expect(rt.inFlight).toBe(false);
    await rt.stop();
    expect(rt.status).toBe("offline");
  });

  it("bridges fleet tool calls and the inbox nudge back to the hub", async () => {
    const { sdk, mkClient, bridgeCalls } = await setup();
    const client = mkClient();
    await client.connect();
    cleanups.push(() => client.disconnect());
    const rt = new RemoteRuntime(client, spec("u1"), silentLog);
    await rt.start();
    const handle = sdk.handles[0]!;
    const tool = toolsOf(handle).find((t) => t.name === "fleet_report");
    expect(tool).toBeTruthy();
    expect(toolsOf(handle).map((t) => t.name)).toEqual(["fleet_report"]);
    const res = await tool!.handler({ note: "hi" }, {});
    expect(res.content[0]!.text).toBe("bridged:fleet_report");
    expect(bridgeCalls).toEqual([{ unitId: "u1", kind: "tool", name: "fleet_report", args: { note: "hi" } }]);
    await rt.stop();
  });

  it("a bridge call made while no hub is attached waits for the next hub", async () => {
    const { sdk, mkClient, bridgeCalls } = await setup();
    const c1 = mkClient();
    await c1.connect();
    const rt = new RemoteRuntime(c1, spec("u1"), silentLog);
    await rt.start();
    const tool = toolsOf(sdk.handles[0]!)[0]!;
    c1.disconnect();
    await until(() => !c1.connected, 1000, "c1 disconnected");
    const pending = tool.handler({ note: "offline" }, {});
    await new Promise((r) => setTimeout(r, 50));
    expect(bridgeCalls).toHaveLength(0);
    const c2 = mkClient();
    await c2.connect();
    cleanups.push(() => c2.disconnect());
    const res = await pending;
    expect(res.content[0]!.text).toBe("bridged:fleet_report");
    expect(bridgeCalls).toHaveLength(1);
  });

  it("keeps the session alive across hubs and replays what the first hub missed", async () => {
    const { host, mkClient } = await setup([scripts.interruptible(), scripts.happy("second turn")]);
    const c1 = mkClient();
    await c1.connect();
    const rt1 = new RemoteRuntime(c1, spec("u1"), silentLog);
    await rt1.start();
    const sid = rt1.sessionId;
    const turn1 = rt1.submit("long task", "operator");
    await until(() => rt1.status === "working", 2000, "working");
    // the hub goes away mid-turn; the host keeps the session and buffers events
    const exits: (Error | undefined)[] = [];
    rt1.on("exit", (e) => exits.push(e));
    c1.disconnect();
    const lost = await turn1;
    expect(lost.ok).toBe(false);
    expect(exits).toHaveLength(1);
    expect(host.unitIds).toEqual(["u1"]);
    await until(() => !host.attached, 1000, "host detached");
    // the turn finishes while detached
    await host.runtime("u1")!.interrupt();
    await until(() => host.runtime("u1")!.status === "done", 2000, "done while detached");

    const c2 = mkClient();
    const hello = await c2.connect();
    cleanups.push(() => c2.disconnect());
    expect(hello.units).toHaveLength(1);
    const hosted = hello.units[0]!;
    expect(hosted.spec.unitId).toBe("u1");
    expect(hosted.status).toBe("done");
    expect(hosted.inFlight).toBe(false);
    expect(hosted.buffered.some((e) => e.name === "result")).toBe(true);

    const rt2 = new RemoteRuntime(c2, hosted.spec, silentLog, hosted);
    const results: unknown[] = [];
    const statuses: string[] = [];
    rt2.on("result", (r) => results.push(r));
    rt2.on("status", (s) => statuses.push(s));
    rt2.replay();
    expect(results).toHaveLength(1);
    expect(statuses.at(-1)).toBe("done");
    expect(rt2.sessionId).toBe(sid);

    // and the adopted runtime is fully usable
    const r2 = await rt2.submit("again", "operator");
    expect(r2.text).toBe("second turn");
    await rt2.stop();
    expect(host.unitIds).toEqual([]);
  });

  it("refuses to host the same unit twice and reports a missing unit", async () => {
    const { mkClient } = await setup();
    const c = mkClient();
    await c.connect();
    cleanups.push(() => c.disconnect());
    const rt = new RemoteRuntime(c, spec("u1"), silentLog);
    await rt.start();
    const dup = new RemoteRuntime(c, spec("u1"), silentLog);
    await expect(dup.start()).rejects.toThrow(/already hosted/);
    await expect(c.request({ type: "interrupt", id: "x", unitId: "nope" })).rejects.toThrow(/not hosted/);
    await rt.stop();
  });
});
