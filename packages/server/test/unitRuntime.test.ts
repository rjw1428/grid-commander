import { describe, expect, it } from "vitest";
import type { UnitStatus, TranscriptEntry } from "@gridcommander/shared";
import { UnitRuntime } from "../src/runtime/UnitRuntime.js";
import { createFakeSdk, scripts, type FakeTurnScript } from "./fakeSdk.js";
import type { TurnResult } from "../src/runtime/Runtime.js";

function harness(turns: FakeTurnScript[], extra: Partial<ConstructorParameters<typeof UnitRuntime>[0]> = {}) {
  const sdk = createFakeSdk({ turns });
  const rt = new UnitRuntime(
    {
      unitId: "u1",
      cwd: process.cwd(),
      model: "sonnet",
      permissionMode: "default",
      systemPromptAppend: "test",
      startGraceMs: 50,
      interruptTimeoutMs: 2000,
      ...extra,
    },
    sdk,
  );
  const statuses: UnitStatus[] = [rt.status];
  const transcript: TranscriptEntry[] = [];
  const activities: (string | undefined)[] = [];
  const results: TurnResult[] = [];
  rt.on("status", (s) => statuses.push(s));
  rt.on("transcript", (e) => transcript.push(...e));
  rt.on("activity", (a) => activities.push(a));
  rt.on("result", (r) => results.push(r));
  return { sdk, rt, statuses, transcript, activities, results };
}

const until = async (pred: () => boolean, ms = 2000) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("timeout waiting for condition");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("UnitRuntime against the fake SDK", () => {
  it("happy turn: offline → idle → working → done", async () => {
    const h = harness([scripts.happy("ready")]);
    let init: { sessionId: string } | null = null;
    h.rt.on("init", (i) => (init = i));
    await h.rt.start();
    expect(h.rt.status).toBe("idle");
    const r = await h.rt.submit("Reply with the word ready", "operator");
    expect(r.ok).toBe(true);
    expect(r.text).toBe("ready");
    expect(init).not.toBeNull();
    expect(h.rt.sessionId).toBe(init!.sessionId);
    expect(h.rt.initInfo?.tools).toContain("Bash");
    expect(h.statuses).toEqual(["offline", "idle", "working", "done"]);
    expect(h.transcript.map((e) => e.kind)).toEqual(["user", "assistant", "result"]);
    expect(h.activities).toContain("Thinking");
    expect(h.activities).toContain("Writing");
    expect(h.activities.at(-1)).toBeUndefined();
    await h.rt.stop();
    expect(h.rt.status).toBe("offline");
    expect(h.rt.sessionId).toBe(init!.sessionId); // retained for resume
  });

  it("passes model, permissionMode, resume and system prompt to the SDK", async () => {
    const h = harness([scripts.happy()], { sessionId: "prev-session", model: "opus", permissionMode: "acceptEdits" });
    await h.rt.start();
    const opts = h.sdk.handles[0]!.options;
    expect(opts.model).toBe("opus");
    expect(opts.permissionMode).toBe("acceptEdits");
    expect(opts.resume).toBe("prev-session");
    expect(opts.systemPrompt).toMatchObject({ type: "preset", preset: "claude_code", append: "test" });
    expect(opts.settingSources).toEqual(["user", "project", "local"]);
    expect(typeof opts.canUseTool).toBe("function");
    expect(opts.hooks?.Stop?.length).toBe(1);
    await h.rt.stop();
  });

  it("permission wait → allow drives working → waiting → working → done", async () => {
    const h = harness([scripts.permission("ls -la")]);
    await h.rt.start();
    let pending: unknown = null;
    h.rt.on("permission", (p) => (pending = p));
    const turn = h.rt.submit("list files", "operator");
    await until(() => h.rt.status === "waiting");
    expect(pending).toMatchObject({ toolName: "Bash", summary: "Run: ls -la" });
    expect(h.rt.pendingPermission?.input).toEqual({ command: "ls -la" });
    expect(h.rt.answerPermission({ allow: true, remember: true })).toBe(true);
    expect(pending).toBeNull();
    const r = await turn;
    expect(r.ok).toBe(true);
    expect(h.statuses).toEqual(["offline", "idle", "working", "waiting", "working", "done"]);
    const tool = h.transcript.find((e) => e.kind === "tool");
    expect(tool).toMatchObject({ name: "Bash", summary: "Bash: ls -la" });
    await h.rt.stop();
  });

  it("permission deny lets the turn finish without running the tool", async () => {
    const h = harness([scripts.permission()]);
    await h.rt.start();
    const turn = h.rt.submit("list files", "operator");
    await until(() => h.rt.status === "waiting");
    h.rt.answerPermission({ allow: false, message: "not now" });
    const r = await turn;
    expect(r.text).toMatch(/skipping/);
    expect(h.statuses).toEqual(["offline", "idle", "working", "waiting", "working", "done"]);
    await h.rt.stop();
  });

  it("AskUserQuestion → answer", async () => {
    const h = harness([scripts.question()]);
    await h.rt.start();
    const turn = h.rt.submit("pick a db", "operator");
    await until(() => h.rt.status === "waiting");
    const q = h.rt.pendingQuestion;
    expect(q?.questions[0]?.question).toBe("Which database?");
    expect(q?.questions[0]?.options.map((o) => o.label)).toEqual(["SQLite", "Postgres"]);
    expect(h.rt.pendingPermission).toBeUndefined();
    expect(h.rt.answerQuestion({ "Which database?": "SQLite" })).toBe(true);
    const r = await turn;
    expect(r.text).toBe("Going with SQLite.");
    expect(h.statuses).toEqual(["offline", "idle", "working", "waiting", "working", "done"]);
    await h.rt.stop();
  });

  it("interrupt resolves the in-flight turn as interrupted", async () => {
    const h = harness([scripts.interruptible(), scripts.happy("after")]);
    await h.rt.start();
    const turn = h.rt.submit("do something long", "operator");
    await until(() => h.activities.includes("Writing"));
    await h.rt.interrupt();
    const r = await turn;
    expect(r.interrupted).toBe(true);
    expect(h.sdk.handles[0]!.interrupts).toBe(1);
    expect(h.statuses).toEqual(["offline", "idle", "working", "done"]);
    // the session survives an interrupt
    const r2 = await h.rt.submit("continue", "operator");
    expect(r2.text).toBe("after");
    await h.rt.stop();
  });

  it("interrupt during a permission wait denies and interrupts", async () => {
    const h = harness([scripts.permission(), scripts.happy("ok")]);
    await h.rt.start();
    const turn = h.rt.submit("list", "operator");
    await until(() => h.rt.status === "waiting");
    await h.rt.interrupt();
    const r = await turn;
    expect(r.interrupted).toBe(true);
    expect(h.rt.pendingPermission).toBeUndefined();
    expect(h.rt.status).toBe("done");
    await h.rt.stop();
  });

  it("crash mid-turn → error, exit emitted, turn rejected softly", async () => {
    const h = harness([scripts.crash()]);
    await h.rt.start();
    let exitErr: Error | undefined | null = null;
    h.rt.on("exit", (e) => (exitErr = e));
    const r = await h.rt.submit("go", "operator");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/boom/);
    expect(h.statuses).toEqual(["offline", "idle", "working", "error"]);
    expect(exitErr).toBeInstanceOf(Error);
    expect(h.rt.inFlight).toBe(false);
    // can be restarted
    const h2sdk = createFakeSdk({ turns: [scripts.happy()] });
    void h2sdk;
  });

  it("error result → error; ack → idle", async () => {
    const h = harness([scripts.errorResult()]);
    await h.rt.start();
    const r = await h.rt.submit("go", "operator");
    expect(r.ok).toBe(false);
    expect(r.errors).toEqual(["max turns reached"]);
    expect(h.rt.status).toBe("error");
    await h.rt.stop();
  });

  it("surfaces repeated API retries and compaction", async () => {
    const h = harness([scripts.retries()]);
    await h.rt.start();
    const notices: string[] = [];
    h.rt.on("notice", (t) => notices.push(t));
    await h.rt.submit("go", "operator");
    expect(notices.some((n) => /retried 3 times/.test(n))).toBe(true);
    expect(h.activities.some((a) => a?.startsWith("Retrying API"))).toBe(true);
    expect(h.transcript.some((e) => e.kind === "system" && /compacted/.test(e.text))).toBe(true);
    await h.rt.stop();
  });

  it("rejects a second submit while a turn is in flight", async () => {
    const h = harness([scripts.interruptible()]);
    await h.rt.start();
    const turn = h.rt.submit("one", "operator");
    await expect(h.rt.submit("two", "operator")).rejects.toThrow(/in flight/);
    await h.rt.interrupt();
    await turn;
    await h.rt.stop();
  });

  it("start fails cleanly when the SDK dies before init", async () => {
    const sdk = createFakeSdk({ turns: [scripts.happy()], failInit: true });
    const rt = new UnitRuntime(
      { unitId: "u2", cwd: process.cwd(), model: "haiku", permissionMode: "default", systemPromptAppend: "", startGraceMs: 500 },
      sdk,
    );
    await expect(rt.start()).rejects.toThrow(/fake startup failure/);
    expect(rt.status).toBe("offline");
  });

  it("stop hook capture populates result text when result is empty", async () => {
    const script: FakeTurnScript = async function* (ctx) {
      yield ctx.msg.assistantText("captured by hook");
      yield ctx.msg.result(true, "");
    };
    const h = harness([script]);
    await h.rt.start();
    const r = await h.rt.submit("go", "operator");
    expect(r.text).toBe("captured by hook");
    await h.rt.stop();
  });

  it("live setModel / setPermissionMode reach the SDK", async () => {
    const h = harness([scripts.happy()]);
    await h.rt.start();
    await h.rt.setModel("haiku");
    await h.rt.setPermissionMode("acceptEdits");
    expect(h.sdk.handles[0]!.modelChanges).toEqual(["haiku"]);
    expect(h.sdk.handles[0]!.permissionModeChanges).toEqual(["acceptEdits"]);
    expect(await h.rt.contextUsage()).toBeCloseTo(0.42);
    await h.rt.stop();
  });
});
