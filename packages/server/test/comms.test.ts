import { afterEach, describe, expect, it } from "vitest";
import type { Message } from "@hexcommand/shared";
import { createTestApp, createTestHub, exampleFleet, until, type TestHub } from "./helpers.js";
import { scripts, type FakeQueryHandle, type FakeTurnScript } from "./fakeSdk.js";

type FakeTool = { name: string; handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[]; isError?: boolean }> };
const toolsOf = (h: FakeQueryHandle): FakeTool[] =>
  ((h.options.mcpServers?.fleet as unknown as { instance: { __fakeTools: FakeTool[] } }).instance.__fakeTools ?? []) as FakeTool[];
const callTool = async (h: FakeQueryHandle, name: string, args: unknown) => {
  const t = toolsOf(h).find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} missing`);
  return t.handler(args, {});
};
const handleFor = (t: TestHub, unitId: string) => {
  const h = t.sdk.handles.find((x) => x.options.cwd !== undefined && toolsOf(x).length && (x as unknown as { unitId?: string }).unitId === unitId);
  if (h) return h;
  // handles are created in start order; map by inspecting the received messages is not possible before a turn,
  // so tag them: the fleet server closure is per unit, use the roster call to identify.
  throw new Error("use findHandle");
};
void handleFor;

const hubs: TestHub[] = [];
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.hub.shutdown();
});

async function setup(turns: FakeTurnScript[] = [scripts.happy()]) {
  const t = createTestHub({ turns });
  hubs.push(t);
  await t.hub.boot(exampleFleet(), { autostart: false });
  // tag handles with the unit they belong to as they are created
  const started: string[] = [];
  const origStart = t.hub.units.start.bind(t.hub.units);
  const start = async (id: string) => {
    const r = await origStart(id);
    const h = t.sdk.handles[t.sdk.handles.length - 1]!;
    (h as unknown as { unitId: string }).unitId = id;
    started.push(id);
    return r;
  };
  const handle = (id: string) => {
    const h = t.sdk.handles.find((x) => (x as unknown as { unitId?: string }).unitId === id);
    if (!h) throw new Error(`no handle for ${id}`);
    return h;
  };
  const texts = (id: string) => handle(id).received.map((m) => m.message.content as string);
  return { ...t, start, handle, texts };
}

describe("CommsBroker policy", () => {
  it("same project / same team / general / major allowed; cross-project denied with an explanation", async () => {
    const c = await setup();
    const f = c.hub.fleet;
    const b = c.hub.comms;
    expect(b.canSend(f.getUnit("xre-cache"), f.getUnit("xre-plan")).ok).toBe(true);
    expect(b.canSend(f.getUnit("xre-cache"), f.getUnit("general")).ok).toBe(true);
    expect(b.canSend(f.getUnit("merge-major"), f.getUnit("web-ui")).ok).toBe(true);
    const denied = b.canSend(f.getUnit("xre-cache"), f.getUnit("web-ui"));
    expect(denied.ok).toBe(false);
    expect((denied as { reason: string }).reason).toMatch(/general/);
    f.createTeam({ name: "cross", memberIds: ["xre-cache", "web-ui"] });
    expect(b.canSend(f.getUnit("xre-cache"), f.getUnit("web-ui")).ok).toBe(true);
    expect(b.canSend(f.getUnit("xre-cache"), f.getUnit("api-build")).ok).toBe(false);
    c.hub.patchSettings({ "comms.crossProject": true });
    expect(b.canSend(f.getUnit("xre-cache"), f.getUnit("api-build")).ok).toBe(true);
  });

  it("roster clamps scope to the caller's rank and always includes the General", async () => {
    const c = await setup();
    const b = c.hub.comms;
    const f = c.hub.fleet;
    const infantry = b.roster(f.getUnit("xre-cache"), "fleet").map((u) => u.id);
    expect(infantry).toContain("xre-plan");
    expect(infantry).toContain("general");
    expect(infantry).not.toContain("web-ui");
    expect(b.roster(f.getUnit("general"), "fleet").length).toBe(13);
  });
});

describe("CommsBroker delivery", () => {
  it("normal message to an idle unit is delivered immediately as an inbox turn", async () => {
    const c = await setup([scripts.happy("got it")]);
    await c.start("xre-cache");
    const r = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "Implement the LRU eviction.", priority: "normal" });
    expect(r.delivery).toBe("turn");
    await until(() => c.texts("xre-cache").length === 1);
    const turn = c.texts("xre-cache")[0]!;
    expect(turn).toMatch(/^\[fleet inbox — 1 message\]/);
    expect(turn).toMatch(/from xre-plan \(Engineer\), thread/);
    expect(turn).toMatch(/Implement the LRU eviction\./);
    expect(turn).toMatch(/fleet_send\(to=<sender id>, replyTo=<thread>\)/);
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "done");
    const msg = c.hub.stores.messages.get(r.message.id)!;
    expect(msg.deliveries["xre-cache"]).toMatchObject({ how: "turn" });
    expect(msg.deliveries["xre-cache"]!.readAt).toBeTruthy();
    expect(c.hub.fleet.getUnit("xre-cache").unreadInbox).toBe(0);
    const tr = c.hub.stores.transcript.list("xre-cache", { limit: 10 });
    expect(tr.some((e) => e.kind === "message" && e.direction === "in")).toBe(true);
  });

  it("working recipient: stored unread, hook nudge, then delivered at the turn boundary after queued orders", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy("q"), scripts.happy("inbox")]);
    await c.start("xre-cache");
    await c.hub.orders.enqueue("xre-cache", "long job", "operator");
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "working");
    await c.hub.orders.enqueue("xre-cache", "queued order", "operator");
    const r = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "rebase first", priority: "normal" });
    expect(r.delivery).toBe("queued");
    expect(c.hub.fleet.getUnit("xre-cache").unreadInbox).toBe(1);
    expect(c.hub.comms.nudge("xre-cache")).toMatch(/1 unread message \(from xre-plan\)/);
    // the fake runs PostToolUse hooks; verify the hook returns the nudge
    const hooks = c.handle("xre-cache").options.hooks?.PostToolUse?.[0]?.hooks ?? [];
    const out = (await hooks[0]!({ hook_event_name: "PostToolUse", session_id: "s", transcript_path: "", cwd: "", tool_name: "Bash", tool_input: {}, tool_response: {}, tool_use_id: "x" } as never, undefined, { signal: new AbortController().signal })) as { hookSpecificOutput?: { additionalContext?: string } };
    expect(out.hookSpecificOutput?.additionalContext).toMatch(/unread/);
    await c.hub.units.interrupt("xre-cache");
    await until(() => c.texts("xre-cache").length === 3, 4000);
    expect(c.texts("xre-cache")[1]).toBe("queued order"); // orders first
    expect(c.texts("xre-cache")[2]).toMatch(/\[fleet inbox — 1 message\]/); // inbox after the queue drains
  });

  it("urgent message interrupts a working unit and is delivered before queued orders", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy("urgent handled"), scripts.happy("q")]);
    await c.start("xre-cache");
    await c.hub.orders.enqueue("xre-cache", "long job", "operator");
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "working");
    await c.hub.orders.enqueue("xre-cache", "queued order", "operator");
    const r = await c.hub.comms.send({ from: "general", to: { kind: "unit", id: "xre-cache" }, body: "STOP: wrong branch", priority: "urgent" });
    expect(r.delivery).toBe("interrupt");
    await until(() => c.texts("xre-cache").length >= 2, 4000);
    expect(c.texts("xre-cache")[1]).toMatch(/^\[URGENT message from general \(General\)\]/);
    expect(c.handle("xre-cache").interrupts).toBe(1);
    await until(() => c.texts("xre-cache").length === 3, 4000);
    expect(c.texts("xre-cache")[2]).toBe("queued order");
    const msg = c.hub.stores.messages.get(r.message.id)!;
    expect(msg.deliveries["xre-cache"]?.how).toBe("interrupt");
    expect(c.hub.alerts.list().some((a) => a.kind === "message" && /Urgent/.test(a.title))).toBe(true);
  });

  it("urgent from a rank without canInterrupt is downgraded; urgent to an idle unit is pointless and downgraded", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy()]);
    await c.start("xre-cache");
    await c.start("xre-plan");
    await c.hub.orders.enqueue("xre-cache", "long", "operator");
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "working");
    const r = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "fyi", priority: "urgent" });
    expect(r.downgraded).toBe(true);
    expect(r.message.priority).toBe("normal");
    expect(c.handle("xre-cache").interrupts).toBe(0);
    const r2 = await c.hub.comms.send({ from: "general", to: { kind: "unit", id: "xre-plan" }, body: "hello", priority: "urgent" });
    expect(r2.downgraded).toBe(true);
    expect(r2.delivery).toBe("turn");
  });

  it("urgent while waiting on a permission is delivered right after the answer", async () => {
    const c = await setup([scripts.permission(), scripts.happy("after urgent")]);
    await c.start("api-build");
    await c.hub.orders.enqueue("api-build", "run tests", "operator");
    await until(() => c.hub.fleet.getUnit("api-build").status === "waiting");
    const r = await c.hub.comms.send({ from: "general", to: { kind: "unit", id: "api-build" }, body: "abort", priority: "urgent" });
    expect(r.delivery).toBe("interrupt");
    expect(c.handle("api-build").interrupts).toBe(0); // cannot interrupt a prompt cleanly
    c.hub.units.answerPermission("api-build", { allow: true });
    await until(() => c.texts("api-build").length === 2, 4000);
    expect(c.texts("api-build")[1]).toMatch(/URGENT message from general/);
    expect(c.handle("api-build").interrupts).toBe(1);
  });

  it("offline recipient holds the message until start", async () => {
    const c = await setup([scripts.happy("read it")]);
    const r = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "when you are up", priority: "normal" });
    expect(r.delivery).toBe("queued");
    expect(c.hub.fleet.getUnit("xre-cache").unreadInbox).toBe(1);
    await c.start("xre-cache");
    await until(() => c.texts("xre-cache").length === 1);
    expect(c.texts("xre-cache")[0]).toMatch(/when you are up/);
  });

  it("fleet_inbox pulls and marks read so the turn-boundary delivery is skipped", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy()]);
    await c.start("xre-cache");
    await c.hub.orders.enqueue("xre-cache", "long", "operator");
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "working");
    await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "pulled by tool", priority: "normal" });
    const res = await callTool(c.handle("xre-cache"), "fleet_inbox", {});
    expect(res.content[0]!.text).toMatch(/pulled by tool/);
    expect(c.hub.fleet.getUnit("xre-cache").unreadInbox).toBe(0);
    await c.hub.units.interrupt("xre-cache");
    await new Promise((r) => setTimeout(r, 100));
    expect(c.texts("xre-cache")).toHaveLength(1); // no inbox turn
    expect((await callTool(c.handle("xre-cache"), "fleet_inbox", {})).content[0]!.text).toBe("Inbox empty.");
  });

  it("fleet_send tool: cross-project denied with explanation, 'general' succeeds, replies keep the thread", async () => {
    const c = await setup([scripts.happy()]);
    await c.start("xre-cache");
    await c.start("general");
    const denied = await callTool(c.handle("xre-cache"), "fleet_send", { to: "web-ui", body: "hi" });
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toMatch(/may only message units in project "xre"/);
    expect(denied.content[0]!.text).toMatch(/"general"/);
    const ok = await callTool(c.handle("xre-cache"), "fleet_send", { to: "general", body: "blocked on web-ui" });
    expect(ok.isError).toBeFalsy();
    const m = /message (\S+) \(thread (\S+)\)/.exec(ok.content[0]!.text)!;
    const reply = await callTool(c.handle("general"), "fleet_send", { to: "xre-cache", body: "on it", replyTo: m[2] });
    const rm = /thread (\S+)\)/.exec(reply.content[0]!.text)!;
    expect(rm[1]).toBe(m[2]);
    const thread = c.hub.stores.messages.query({ threadId: m[2]!, limit: 10 });
    expect(thread.map((x: Message) => x.from)).toEqual(["xre-cache", "general"]);
    expect(thread[1]!.replyTo).toBe(m[1]);
    // a General recipient raises a message alert
    expect(c.hub.alerts.list().some((a) => a.kind === "message" && a.unitId === "general")).toBe(true);
    const roster = await callTool(c.handle("xre-cache"), "fleet_roster", {});
    expect(roster.content[0]!.text).toMatch(/xre-plan/);
    expect(roster.content[0]!.text).not.toMatch(/web-ui/);
  });

  it("a reply to the unit that last wrote to you is threaded implicitly; replyTo accepts a thread id", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy()]);
    await c.start("xre-cache");
    await c.start("xre-plan");
    await c.hub.orders.enqueue("xre-cache", "busy", "operator");
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "working");
    const first = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "which branch?", priority: "normal" });
    const back = await c.hub.comms.send({ from: "xre-cache", to: { kind: "unit", id: "xre-plan" }, body: "main", priority: "normal" });
    expect(back.message.threadId).toBe(first.message.threadId);
    expect(back.message.replyTo).toBe(first.message.id);
    const again = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-cache" }, body: "thanks", priority: "normal", replyTo: first.message.threadId });
    expect(again.message.threadId).toBe(first.message.threadId);
    const unrelated = await c.hub.comms.send({ from: "xre-plan", to: { kind: "unit", id: "xre-review" }, body: "hello", priority: "normal" });
    expect(unrelated.message.threadId).toBe(unrelated.message.id);
  });

  it("fleet_report updates the mission line, raises an info alert, flags done; fleet_request_review targets the Captain", async () => {
    const c = await setup([scripts.happy()]);
    await c.start("xre-cache");
    await callTool(c.handle("xre-cache"), "fleet_report", { task: "LRU eviction done", note: "all tests green", done: true });
    const u = c.hub.fleet.getUnit("xre-cache");
    expect(u.task).toBe("LRU eviction done");
    expect(u.missionDone).toBe(true);
    expect(c.hub.alerts.list().some((a) => a.kind === "info" && a.unitId === "xre-cache" && /green/.test(a.body))).toBe(true);
    const rr = await callTool(c.handle("xre-cache"), "fleet_request_review", { summary: "Please review the cache change", paths: ["src/cache.ts"] });
    expect(rr.content[0]!.text).toMatch(/xre-review/);
    const msgs = c.hub.stores.messages.query({ unitId: "xre-review", limit: 5 });
    expect(msgs[0]!.body).toMatch(/Review request from xre-cache/);
    expect(msgs[0]!.body).toMatch(/src\/cache\.ts/);
  });

  it("operator relay output sends the source unit's last result", async () => {
    const c = await setup([scripts.happy("the answer is 42")]);
    await c.start("xre-plan");
    await c.hub.units.submit("xre-plan", "think", "operator");
    const r = await c.hub.comms.sendOperatorMessage({ to: { kind: "unit", id: "xre-cache" }, body: "FYI", priority: "normal", relayedFrom: "xre-plan" });
    expect(r.message.relayedFrom).toBe("xre-plan");
    expect(r.message.body).toMatch(/\[Relayed output of xre-plan\]\nthe answer is 42/);
    await expect(c.hub.comms.sendOperatorMessage({ to: { kind: "unit", id: "xre-cache" }, body: "", priority: "normal", relayedFrom: "web-ui" })).rejects.toThrow(/no result/);
  });

  it("REST: operator message to a project fans out, message.new reaches the bus", async () => {
    const c = await setup([scripts.happy()]);
    const a = await createTestApp(c);
    const events: string[] = [];
    c.hub.bus.on("event", (e) => events.push(e.type));
    const r = await a.req("POST", "/messages", { to: { kind: "project", id: "web" }, body: "all web units: freeze", priority: "normal" });
    expect(r.status).toBe(201);
    expect(r.json.recipients.sort()).toEqual(["web-review", "web-scout", "web-ui"]);
    expect(events).toContain("message.new");
    await a.app.close();
  });
});
