import { afterEach, describe, expect, it } from "vitest";
import { createTestApp, createTestHub, exampleFleet, until, type TestHub } from "./helpers.js";
import { scripts } from "./fakeSdk.js";

type Ctx = Awaited<ReturnType<typeof createTestApp>> & TestHub;
const ctxs: Ctx[] = [];

async function setup(turns = [scripts.happy()]): Promise<Ctx> {
  const t = createTestHub({ turns });
  await t.hub.boot(exampleFleet(), { autostart: false });
  const a = await createTestApp(t);
  const ctx = { ...t, ...a };
  ctxs.push(ctx);
  return ctx;
}

afterEach(async () => {
  for (const c of ctxs.splice(0)) {
    await c.app.close();
    await c.hub.shutdown();
  }
});

describe("REST contract", () => {
  it("GET /state returns the full snapshot", async () => {
    const c = await setup();
    const r = await c.req("GET", "/state");
    expect(r.status).toBe(200);
    expect(r.json.projects).toHaveLength(4);
    expect(r.json.units).toHaveLength(14);
    expect(r.json.unitTypes.map((t: { id: string }) => t.id)).toContain("general");
    expect(r.json.server).toMatchObject({ runningUnits: 0, maxUnits: 24, hasHq: true });
    expect(r.json.settings["comms.crossProject"]).toBe(false);
  });

  it("units: create / get / patch / delete with validation errors", async () => {
    const c = await setup();
    const bad = await c.req("POST", "/units", { name: "x", type: "wizard", projectId: "xre" });
    expect(bad.status).toBe(400);
    const created = await c.req("POST", "/units", { name: "fresh", type: "infantry", projectId: "xre", task: "do it" });
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ id: "fresh", status: "offline", hex: [2, 1], model: "sonnet" });
    const dup = await c.req("POST", "/units", { name: "fresh", type: "infantry", projectId: "xre" });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("name_taken");
    const occ = await c.req("POST", "/units", { name: "occ", type: "infantry", projectId: "xre", hex: [0, 0] });
    expect(occ.status).toBe(409);
    expect(occ.json.error.code).toBe("hex_occupied");
    const out = await c.req("POST", "/units", { name: "out", type: "infantry", projectId: "xre", hex: [9, 9] });
    expect(out.status).toBe(400);

    const patched = await c.req("PATCH", "/units/fresh", { task: "new task", hex: [1, 2], teamId: "t1" });
    expect(patched.status).toBe(200);
    expect(patched.json).toMatchObject({ task: "new task", hex: [1, 2], teamId: "t1" });
    const got = await c.req("GET", "/units/fresh");
    expect(got.json.orders).toEqual([]);
    const gone = await c.req("DELETE", "/units/fresh");
    expect(gone.status).toBe(204);
    expect((await c.req("GET", "/units/fresh")).status).toBe(404);
    expect((await c.req("PATCH", "/units/nope", { task: "x" })).status).toBe(404);
  });

  it("start / order / done / ack / stop lifecycle via REST", async () => {
    const c = await setup([scripts.happy("ready")]);
    const started = await c.req("POST", "/units/xre-cache/start");
    expect(started.status).toBe(200);
    expect(started.json.status).toBe("idle");
    expect((await c.req("POST", "/units/xre-cache/start")).status).toBe(409);

    const order = await c.req("POST", "/units/xre-cache/orders", { text: "say ready" });
    expect(order.status).toBe(201);
    expect(order.json).toMatchObject({ queued: false });
    await until(() => c.hub.fleet.getUnit("xre-cache").status === "done", 3000, "done");
    const unit = c.hub.fleet.getUnit("xre-cache");
    expect(unit.lastResult?.text).toBe("ready");
    expect(unit.sessionId).toBeTruthy();

    const tr = await c.req("GET", "/units/xre-cache/transcript?limit=10");
    expect(tr.json.entries.map((e: { kind: string }) => e.kind)).toEqual(["user", "assistant", "result"]);
    const md = await c.app.inject({ method: "GET", url: "/api/units/xre-cache/transcript.md", headers: c.auth });
    expect(md.statusCode).toBe(200);
    expect(md.headers["content-type"]).toMatch(/markdown/);
    expect(md.body).toMatch(/^# xre-cache — transcript/);
    expect(md.body).toMatch(/say ready/);
    expect(md.body).toMatch(/\*\*result\*\*/);
    // context watchdog: the fake SDK reports 42 % → no alert; force the threshold path
    await c.hub.checkContext();
    expect(c.hub.alerts.list().some((a) => /context/.test(a.title))).toBe(false);

    const alerts = await c.req("GET", "/alerts");
    expect(alerts.json.some((a: { kind: string; unitId: string }) => a.kind === "done" && a.unitId === "xre-cache")).toBe(true);

    const acked = await c.req("POST", "/units/xre-cache/ack");
    expect(acked.json.status).toBe("idle");
    const stopped = await c.req("POST", "/units/xre-cache/stop");
    expect(stopped.json.status).toBe("offline");
    expect(stopped.json.sessionId).toBe(unit.sessionId);
  });

  it("orders queue while working, drain in order, can be removed; interrupt & send jumps the queue", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy("second"), scripts.happy("third")]);
    await c.req("POST", "/units/xre-plan/start");
    const first = await c.req("POST", "/units/xre-plan/orders", { text: "long task" });
    expect(first.json.queued).toBe(false);
    await until(() => c.hub.fleet.getUnit("xre-plan").status === "working");

    const q1 = await c.req("POST", "/units/xre-plan/orders", { text: "queued one" });
    expect(q1.json.queued).toBe(true);
    const q2 = await c.req("POST", "/units/xre-plan/orders", { text: "queued two" });
    expect(c.hub.fleet.getUnit("xre-plan").queueLength).toBe(2);
    const list = await c.req("GET", "/units/xre-plan/orders");
    expect(list.json.map((o: { text: string }) => o.text)).toEqual(["queued one", "queued two"]);
    expect((await c.req("DELETE", `/units/xre-plan/orders/${q2.json.orderId}`)).status).toBe(204);
    expect((await c.req("DELETE", `/units/xre-plan/orders/${q2.json.orderId}`)).status).toBe(404);
    expect(c.hub.fleet.getUnit("xre-plan").queueLength).toBe(1);

    const urgent = await c.req("POST", "/units/xre-plan/orders", { text: "urgent now", interrupt: true });
    expect(urgent.json.queued).toBe(false);
    // interrupted result → drain submits "urgent now" first, then "queued one"
    await until(() => c.sdk.handles[0]!.received.length >= 3, 4000, "three turns");
    const texts = c.sdk.handles[0]!.received.map((m) => m.message.content as string);
    expect(texts).toEqual(["long task", "urgent now", "queued one"]);
    await until(() => c.hub.fleet.getUnit("xre-plan").queueLength === 0 && c.hub.fleet.getUnit("xre-plan").status === "done");
  });

  it("permission: approve via REST; nothing pending → 409", async () => {
    const c = await setup([scripts.permission("npm test")]);
    expect((await c.req("POST", "/units/api-build/permission", { allow: true })).status).toBe(409);
    await c.req("POST", "/units/api-build/start");
    await c.req("POST", "/units/api-build/orders", { text: "run tests" });
    await until(() => c.hub.fleet.getUnit("api-build").status === "waiting");
    const u = c.hub.fleet.getUnit("api-build");
    expect(u.pendingPermission).toMatchObject({ toolName: "Bash", summary: "Run: npm test" });
    const alerts = await c.req("GET", "/alerts");
    expect(alerts.json.find((a: { kind: string }) => a.kind === "waiting")).toMatchObject({ unitId: "api-build", body: "Run: npm test" });
    const ans = await c.req("POST", "/units/api-build/permission", { allow: true, remember: true });
    expect(ans.status).toBe(200);
    await until(() => c.hub.fleet.getUnit("api-build").status === "done");
    expect(c.hub.fleet.getUnit("api-build").pendingPermission).toBeUndefined();
    const after = await c.req("GET", "/alerts");
    expect(after.json.some((a: { kind: string }) => a.kind === "waiting")).toBe(false);
  });

  it("AskUserQuestion: answer via REST", async () => {
    const c = await setup([scripts.question()]);
    await c.req("POST", "/units/web-ui/start");
    await c.req("POST", "/units/web-ui/orders", { text: "pick" });
    await until(() => c.hub.fleet.getUnit("web-ui").status === "waiting");
    expect(c.hub.fleet.getUnit("web-ui").pendingQuestion?.questions[0]?.options).toHaveLength(2);
    expect((await c.req("POST", "/units/web-ui/answer", { answers: { "Which database?": "Postgres" } })).status).toBe(200);
    await until(() => c.hub.fleet.getUnit("web-ui").status === "done");
    expect(c.hub.fleet.getUnit("web-ui").lastResult?.text).toBe("Going with Postgres.");
  });

  it("interrupt, compact, and error → ack", async () => {
    const c = await setup([scripts.interruptible(), scripts.errorResult()]);
    await c.req("POST", "/units/xre-perf/start");
    await c.req("POST", "/units/xre-perf/orders", { text: "go" });
    await until(() => c.hub.fleet.getUnit("xre-perf").status === "working");
    const i = await c.req("POST", "/units/xre-perf/interrupt");
    expect(i.status).toBe(200);
    await until(() => c.hub.fleet.getUnit("xre-perf").status === "done");
    const compact = await c.req("POST", "/units/xre-perf/compact");
    expect(compact.status).toBe(201);
    await until(() => c.hub.fleet.getUnit("xre-perf").status === "error");
    expect(c.sdk.handles[0]!.received.at(-1)?.message.content).toBe("/compact");
    const alerts = await c.req("GET", "/alerts");
    expect(alerts.json.find((a: { kind: string }) => a.kind === "error")).toMatchObject({ unitId: "xre-perf", body: "max turns reached" });
    expect((await c.req("POST", "/units/xre-perf/ack")).json.status).toBe("idle");
  });

  it("an order to an offline unit auto-starts it and runs", async () => {
    const c = await setup([scripts.happy("auto")]);
    const r = await c.req("POST", "/units/web-scout/orders", { text: "hello" });
    expect(r.json.queued).toBe(true);
    await until(() => c.hub.fleet.getUnit("web-scout").status === "done", 3000);
    expect(c.hub.fleet.getUnit("web-scout").lastResult?.text).toBe("auto");
  });

  it("recruit with firstOrder starts and runs", async () => {
    const c = await setup([scripts.happy("recruited")]);
    const r = await c.req("POST", "/units", { name: "newbie", type: "infantry", projectId: "api", firstOrder: "introduce yourself" });
    expect(r.status).toBe(201);
    await until(() => c.hub.fleet.getUnit("newbie").status === "done", 3000);
    expect(c.hub.fleet.getUnit("newbie").lastResult?.text).toBe("recruited");
  });

  it("max units cap is enforced", async () => {
    const t = createTestHub({ hub: { maxUnits: 1 } });
    await t.hub.boot(exampleFleet(), { autostart: false });
    const a = await createTestApp(t);
    ctxs.push({ ...t, ...a });
    expect((await a.req("POST", "/units/xre-plan/start")).status).toBe(200);
    const r = await a.req("POST", "/units/xre-cache/start");
    expect(r.status).toBe(409);
    expect(r.json.error.code).toBe("max_units");
  });

  it("broadcast to a project with queueIfBusy=false skips busy units", async () => {
    const c = await setup([scripts.interruptible(), scripts.happy()]);
    await c.req("POST", "/units/web-ui/start");
    await c.req("POST", "/units/web-ui/orders", { text: "busy" });
    await until(() => c.hub.fleet.getUnit("web-ui").status === "working");
    const r = await c.req("POST", "/broadcast", { to: { kind: "project", id: "web" }, text: "all hands", queueIfBusy: false });
    expect(r.status).toBe(200);
    expect(r.json.skipped).toEqual(["web-ui"]);
    expect([...r.json.sent, ...r.json.queued].sort()).toEqual(["web-review", "web-scout"]);
    const r2 = await c.req("POST", "/broadcast", { to: { kind: "units", ids: ["web-ui"] }, text: "later", queueIfBusy: true });
    expect(r2.json.queued).toEqual(["web-ui"]);
    expect((await c.req("POST", "/broadcast", { to: { kind: "team", id: "nope" }, text: "x" })).status).toBe(404);
  });

  it("operator messages: stored, listed per unit and per thread", async () => {
    const c = await setup();
    expect((await c.req("GET", "/messages")).json).toEqual({ messages: [] });
    const r = await c.req("POST", "/messages", { to: { kind: "unit", id: "xre-plan" }, body: "hi" });
    expect(r.status).toBe(201);
    expect(r.json.message).toMatchObject({ from: "operator", priority: "normal" });
    expect(r.json.delivery).toBe("queued"); // offline unit holds it
    const list = await c.req("GET", "/units/xre-plan/messages");
    expect(list.json.messages).toHaveLength(1);
    const thread = await c.req("GET", `/messages?threadId=${r.json.message.threadId}`);
    expect(thread.json.messages).toHaveLength(1);
    expect(c.hub.fleet.getUnit("xre-plan").unreadInbox).toBe(1);
  });

  it("projects and teams CRUD", async () => {
    const c = await setup();
    const p = await c.req("POST", "/projects", { name: "Side Quest", cwd: "/tmp/sq" });
    expect(p.status).toBe(201);
    expect(p.json.cells).toHaveLength(7);
    expect((await c.req("PATCH", "/projects/side-quest", { name: "Side Quest 2" })).json.name).toBe("Side Quest 2");
    expect((await c.req("DELETE", "/projects/xre")).status).toBe(409);
    expect((await c.req("DELETE", "/projects/side-quest")).status).toBe(204);
    expect((await c.req("GET", "/projects")).json).toHaveLength(4);

    const t = await c.req("POST", "/teams", { name: "Alpha", memberIds: ["web-ui", "api-build"] });
    expect(t.status).toBe(201);
    expect(c.hub.fleet.getUnit("web-ui").teamId).toBe("alpha");
    expect((await c.req("PATCH", "/teams/alpha", { memberIds: ["web-ui"], color: "#123456" })).json.color).toBe("#123456");
    expect(c.hub.fleet.getUnit("api-build").teamId).toBeUndefined();
    expect((await c.req("DELETE", "/teams/alpha")).status).toBe(204);
    expect(c.hub.fleet.getUnit("web-ui").teamId).toBeUndefined();
    expect((await c.req("GET", "/teams")).json).toHaveLength(1);
  });

  it("alerts dismiss / dismiss-all, settings, push subscription", async () => {
    const c = await setup();
    const a = c.hub.alerts.raise({ kind: "info", title: "hello", body: "world" });
    expect((await c.req("POST", `/alerts/${a.id}/dismiss`)).status).toBe(204);
    expect((await c.req("POST", `/alerts/${a.id}/dismiss`)).status).toBe(404);
    c.hub.alerts.raise({ kind: "info", unitId: "xre-plan", title: "a", body: "b" });
    c.hub.alerts.raise({ kind: "idle", unitId: "xre-plan", title: "a", body: "b" });
    expect((await c.req("POST", "/alerts/dismiss-all")).json).toEqual({ dismissed: 2 });

    expect((await c.req("GET", "/settings")).json["alerts.idleMs"]).toBe(120000);
    const s = await c.req("PATCH", "/settings", { "comms.crossProject": true, "alerts.idleMs": 5000 });
    expect(s.json).toMatchObject({ "comms.crossProject": true, "alerts.idleMs": 5000 });
    expect((await c.req("PATCH", "/settings", { "alerts.idleMs": -1 })).status).toBe(400);

    expect((await c.req("GET", "/push/vapid-public-key")).json).toEqual({ key: null });
    const sub = { endpoint: "https://push.example/abc", keys: { p256dh: "p", auth: "a" } };
    expect((await c.req("POST", "/push/subscribe", sub)).status).toBe(201);
    expect(c.hub.stores.push.all()).toHaveLength(1);
    expect((await c.req("DELETE", "/push/subscribe", { endpoint: sub.endpoint })).json).toEqual({ removed: true });
  });

  it("unknown routes 404 with the error envelope", async () => {
    const c = await setup();
    const r = await c.req("GET", "/nope");
    expect(r.status).toBe(404);
    expect(r.json).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});
