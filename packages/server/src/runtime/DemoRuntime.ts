/**
 * Scripted runtime for demos and UI end-to-end tests (FLEET_DEMO=1). No Claude involved.
 * Order text steers the script:
 *   contains "permission" → asks to run a Bash command
 *   contains "question"   → asks a multiple-choice question
 *   contains "fail"       → errors
 *   contains "long"       → works for ~20 s (interruptible)
 *   otherwise             → thinks, edits a file, replies
 */
import { nanoid } from "nanoid";
import type { OrderSource, PendingQuestion, PermissionMode, PermissionRequest, UnitStatus } from "@hexcommand/shared";
import { Emitter } from "./emitter.js";
import type { InitInfo, PermissionAnswer, Runtime, RuntimeEvents, TurnResult } from "./Runtime.js";
import { nextStatus, type StatusEvent } from "./statusMachine.js";

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    });
  });

export interface DemoRuntimeOptions {
  unitId: string;
  name: string;
  model: string;
  permissionMode: PermissionMode;
  sessionId?: string;
  /** Time scale; 1 = realistic pacing, 0.05 = tests. */
  speed?: number;
}

export class DemoRuntime implements Runtime {
  readonly unitId: string;
  #events = new Emitter<RuntimeEvents>();
  #status: UnitStatus = "offline";
  #sessionId: string | undefined;
  #opts: DemoRuntimeOptions;
  #turn: { resolve: (r: TurnResult) => void; abort: AbortController } | null = null;
  #permission: { request: PermissionRequest; resolve: (allow: boolean) => void } | null = null;
  #question: { question: PendingQuestion; resolve: (a: Record<string, string>) => void } | null = null;
  #costSoFar = 0;

  constructor(opts: DemoRuntimeOptions) {
    this.unitId = opts.unitId;
    this.#opts = opts;
    this.#sessionId = opts.sessionId;
  }
  get status() {
    return this.#status;
  }
  get sessionId() {
    return this.#sessionId;
  }
  get inFlight() {
    return this.#turn !== null;
  }
  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]) {
    return this.#events.on(event, listener);
  }

  async start(): Promise<void> {
    if (this.#status !== "offline") throw new Error("already started");
    this.#sessionId = this.#sessionId ?? `demo-${nanoid(12)}`;
    this.#set({ type: "init" });
    const info: InitInfo = { sessionId: this.#sessionId, model: `demo-${this.#opts.model}`, tools: ["Bash", "Read", "Edit"], mcpServers: [{ name: "fleet", status: "connected" }] };
    this.#events.emit("init", info);
  }

  async stop(): Promise<void> {
    this.#turn?.abort.abort();
    this.#permission?.resolve(false);
    this.#question?.resolve({});
    this.#permission = null;
    this.#question = null;
    if (this.#turn) {
      const t = this.#turn;
      this.#turn = null;
      t.resolve({ ok: false, text: "Stopped", interrupted: true, at: Date.now() });
    }
    this.#events.emit("activity", undefined);
    this.#set({ type: "stop" });
    this.#events.emit("exit", undefined);
  }

  async submit(text: string, source: OrderSource): Promise<TurnResult> {
    if (this.#status === "offline") throw new Error("offline");
    if (this.#turn) throw new Error("turn in flight");
    const abort = new AbortController();
    const result = new Promise<TurnResult>((resolve) => {
      this.#turn = { resolve, abort };
    });
    const at = Date.now();
    this.#events.emit("transcript", [{ kind: "user", at, text, source }]);
    this.#set({ type: "submit" });
    void this.#run(text, abort.signal);
    return result;
  }

  async interrupt(): Promise<void> {
    if (!this.#turn) return;
    this.#permission?.resolve(false);
    this.#question?.resolve({});
    this.#turn.abort.abort();
    await new Promise<void>((resolve) => {
      const off = this.#events.on("result", () => {
        off();
        resolve();
      });
    });
  }

  answerPermission(answer: PermissionAnswer): boolean {
    const p = this.#permission;
    if (!p) return false;
    this.#permission = null;
    this.#events.emit("permission", null);
    this.#set({ type: "answered" });
    p.resolve(answer.allow);
    return true;
  }

  answerQuestion(answers: Record<string, string>): boolean {
    const q = this.#question;
    if (!q) return false;
    this.#question = null;
    this.#events.emit("question", null);
    this.#set({ type: "answered" });
    q.resolve(answers);
    return true;
  }

  async setModel(model: string) {
    this.#opts.model = model;
  }
  async setPermissionMode(mode: PermissionMode) {
    this.#opts.permissionMode = mode;
  }
  async contextUsage() {
    return Math.min(0.95, 0.1 + this.#costSoFar * 20);
  }

  // ------------------------------------------------------------------ script

  #s(ms: number) {
    return ms * (this.#opts.speed ?? 1);
  }

  async #run(text: string, signal: AbortSignal): Promise<void> {
    const lower = text.toLowerCase();
    const say = (t: string) => this.#events.emit("transcript", [{ kind: "assistant", at: Date.now(), text: t }]);
    const tool = (name: string, summary: string, ms: number) => {
      const id = "demo_" + nanoid(6);
      this.#events.emit("transcript", [{ kind: "tool", at: Date.now(), name, summary, toolUseId: id }]);
      this.#events.emit("activity", summary);
      return sleep(this.#s(ms), signal).then(() => {
        if (!signal.aborted) this.#events.emit("toolResult", { toolUseId: id, ok: true, at: Date.now() });
      });
    };

    this.#events.emit("activity", "Thinking");
    await sleep(this.#s(900), signal);
    let resultText = "";
    let ok = true;

    if (!signal.aborted && lower.includes("permission")) {
      const cmd = "npm test";
      const request: PermissionRequest = { requestId: nanoid(8), toolName: "Bash", input: { command: cmd }, summary: `Run: ${cmd}`, at: Date.now() };
      this.#events.emit("transcript", [{ kind: "tool", at: Date.now(), name: "Bash", summary: `Bash: ${cmd}`, toolUseId: "demo_perm_" + request.requestId }]);
      const allowed = await new Promise<boolean>((resolve) => {
        this.#permission = { request, resolve };
        this.#events.emit("permission", request);
        this.#set({ type: "wait" });
      });
      if (allowed && !signal.aborted) {
        this.#events.emit("activity", `Bash: ${cmd}`);
        await sleep(this.#s(1500), signal);
        say("Tests pass: 42 passed, 0 failed.");
        resultText = "Status: tests green.\n\nRan `npm test`; 42 passed, 0 failed.";
      } else {
        say("Understood, I will not run the tests.");
        resultText = "Status: skipped the test run at your request.";
      }
    } else if (!signal.aborted && lower.includes("question")) {
      const question: PendingQuestion = {
        toolUseId: nanoid(8),
        questions: [
          {
            question: "Which approach should I take?",
            header: "Approach",
            options: [
              { label: "Minimal patch", description: "Smallest change that fixes the bug" },
              { label: "Refactor", description: "Clean up the module while fixing it" },
            ],
          },
        ],
        at: Date.now(),
      };
      const answers = await new Promise<Record<string, string>>((resolve) => {
        this.#question = { question, resolve };
        this.#events.emit("question", question);
        this.#set({ type: "wait" });
      });
      const choice = answers["Which approach should I take?"] ?? "(none)";
      await sleep(this.#s(800), signal);
      say(`Going with: ${choice}.`);
      resultText = `Status: proceeding with ${choice}.`;
    } else if (!signal.aborted && lower.includes("fail")) {
      await tool("Bash", "Bash: make build", 1200);
      say("The build is broken and I cannot fix it without the missing header.");
      ok = false;
      resultText = "Build failed: missing header foo.h";
    } else if (!signal.aborted && lower.includes("long")) {
      say("Starting a long task.");
      for (let i = 0; i < 10 && !signal.aborted; i++) {
        await tool(i % 2 ? "Edit" : "Read", i % 2 ? `Edit: module${i}.ts` : `Read: module${i}.ts`, 2000);
      }
      resultText = "Status: long task finished.";
    } else {
      await tool("Read", "Read: README.md", 800);
      await tool("Edit", "Edit: src/index.ts", 1200);
      this.#events.emit("activity", "Writing");
      await sleep(this.#s(600), signal);
      say(`Done. Handled: "${text.slice(0, 60)}"`);
      resultText = `Status: done.\n\nHandled "${text.slice(0, 80)}" (demo).`;
    }

    if (signal.aborted) {
      resultText = "[Request interrupted by user]";
    }
    const cost = 0.002 + Math.random() * 0.004;
    this.#costSoFar += cost;
    const r: TurnResult = { ok: !signal.aborted && ok, text: resultText, costUsd: cost, durationMs: 1000, interrupted: signal.aborted || undefined, at: Date.now() };
    this.#events.emit("transcript", [{ kind: "result", at: Date.now(), ok: r.ok, text: resultText, costUsd: cost }]);
    const t = this.#turn;
    this.#turn = null;
    this.#permission = null;
    this.#question = null;
    this.#events.emit("activity", undefined);
    this.#set({ type: "result", ok: r.ok });
    this.#events.emit("result", r);
    t?.resolve(r);
  }

  #set(e: StatusEvent) {
    const n = nextStatus(this.#status, e);
    if (n === this.#status) return;
    this.#status = n;
    this.#events.emit("status", n, Date.now());
  }
}
