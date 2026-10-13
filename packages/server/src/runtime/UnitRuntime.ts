/**
 * The ONLY file that imports the Agent SDK at runtime (see CLAUDE.md). Everything else talks to
 * the Runtime interface. Tests inject a fake SdkFacade from test/fakeSdk.ts.
 */
import { createSdkMcpServer, query, tool } from "@anthropic-ai/claude-agent-sdk";
import { nanoid } from "nanoid";
import type {
  OrderSource,
  PendingQuestion,
  PermissionMode,
  PermissionRequest,
  TranscriptEntry,
  UnitStatus,
} from "@hexcommand/shared";
import { Emitter } from "./emitter.js";
import type { InitInfo, PermissionAnswer, Runtime, RuntimeEvents, TurnResult } from "./Runtime.js";
import { nextStatus, type StatusEvent } from "./statusMachine.js";
import {
  activityFromBlocks,
  activityFromSystem,
  summarizeInput,
  summarizePermission,
  toolResultsFromUserBlocks,
  transcriptFromAssistantBlocks,
  type ContentBlock,
} from "./activity.js";
import type {
  HookCallbackMatcher,
  HookEvent,
  McpServerConfig,
  Options,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKMessage,
  SDKUserMessage,
  StopHookInput,
} from "./sdkTypes.js";

export interface SdkFacade {
  query: typeof query;
  createSdkMcpServer: typeof createSdkMcpServer;
  tool: typeof tool;
}

export const realSdk: SdkFacade = { query, createSdkMcpServer, tool };

export interface RuntimeLogger {
  debug: (obj: unknown, msg?: string) => void;
  info: (obj: unknown, msg?: string) => void;
  warn: (obj: unknown, msg?: string) => void;
  error: (obj: unknown, msg?: string) => void;
}

const silentLog: RuntimeLogger = { debug() {}, info() {}, warn() {}, error() {} };

export interface UnitRuntimeOptions {
  unitId: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  sessionId?: string;
  systemPromptAppend: string;
  /** Built lazily so the SDK's createSdkMcpServer/tool are only reached through the facade. */
  mcpServers?: (sdk: SdkFacade) => Record<string, McpServerConfig>;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  env?: Record<string, string | undefined>;
  settingSources?: ("user" | "project" | "local")[];
  log?: RuntimeLogger;
  /** How long start() watches for an early process exit before resolving. */
  startGraceMs?: number;
  /** How long interrupt() waits for the interrupted result before giving up. */
  interruptTimeoutMs?: number;
}

interface PendingTurn {
  source: OrderSource;
  startedAt: number;
  resolve: (r: TurnResult) => void;
}

interface PendingPermission {
  request: PermissionRequest;
  rawInput: Record<string, unknown>;
  suggestions: PermissionUpdate[] | undefined;
  resolve: (r: PermissionResult) => void;
}

interface PendingQuestionState {
  question: PendingQuestion;
  rawInput: Record<string, unknown>;
  resolve: (r: PermissionResult) => void;
}

export class UnitRuntime implements Runtime {
  readonly unitId: string;
  #opts: UnitRuntimeOptions;
  #sdk: SdkFacade;
  #log: RuntimeLogger;
  #events: Emitter<RuntimeEvents>;

  #query: Query | null = null;
  #status: UnitStatus = "offline";
  #sessionId: string | undefined;
  #model: string;
  #permissionMode: PermissionMode;

  #input: SDKUserMessage[] = [];
  #inputWake: (() => void) | null = null;
  #inputClosed = false;

  #pendingTurn: PendingTurn | null = null;
  #pendingPermission: PendingPermission | null = null;
  #pendingQuestion: PendingQuestionState | null = null;
  #startWaiters: { resolve: () => void; reject: (e: Error) => void } | null = null;
  #initInfo: InitInfo | null = null;

  #stopCaptured: string | undefined;
  #interrupting = false;
  #closing = false;
  #retryCount = 0;
  #rateLimitNoticed = false;

  constructor(opts: UnitRuntimeOptions, sdk: SdkFacade = realSdk) {
    this.unitId = opts.unitId;
    this.#opts = opts;
    this.#sdk = sdk;
    this.#log = opts.log ?? silentLog;
    this.#sessionId = opts.sessionId;
    this.#model = opts.model;
    this.#permissionMode = opts.permissionMode;
    this.#events = new Emitter<RuntimeEvents>((err, ev) =>
      this.#log.error({ err, ev, unitId: this.unitId }, "runtime listener threw"),
    );
  }

  // --------------------------------------------------------------------- getters

  get status(): UnitStatus {
    return this.#status;
  }
  get sessionId(): string | undefined {
    return this.#sessionId;
  }
  get inFlight(): boolean {
    return this.#pendingTurn !== null;
  }
  get model(): string {
    return this.#model;
  }
  get permissionMode(): PermissionMode {
    return this.#permissionMode;
  }
  get pendingPermission(): PermissionRequest | undefined {
    return this.#pendingPermission?.request;
  }
  get pendingQuestion(): PendingQuestion | undefined {
    return this.#pendingQuestion?.question;
  }

  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]): () => void {
    return this.#events.on(event, listener);
  }

  // --------------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    if (this.#query) throw new Error(`unit ${this.unitId} already started`);
    this.#closing = false;
    this.#inputClosed = false;
    this.#input = [];
    this.#initInfo = null;
    this.#retryCount = 0;

    const options = this.#buildOptions();
    this.#log.info({ unitId: this.unitId, resume: this.#sessionId, model: this.#model }, "starting unit");

    // The SDK emits system/init only after the first user message in streaming-input mode, so we
    // cannot wait for it here. Instead: spawn, then watch for an early exit during a grace window.
    const grace = new Promise<void>((resolve, reject) => {
      this.#startWaiters = { resolve, reject };
    });
    const graceMs = this.#opts.startGraceMs ?? 1500;
    const timer = setTimeout(() => {
      const w = this.#startWaiters;
      this.#startWaiters = null;
      w?.resolve();
    }, graceMs);

    try {
      this.#query = this.#sdk.query({ prompt: this.#inputIterable(), options });
    } catch (err) {
      clearTimeout(timer);
      this.#startWaiters = null;
      throw err;
    }
    void this.#pump(this.#query);
    this.#setStatus({ type: "init" });

    try {
      await grace;
    } finally {
      clearTimeout(timer);
    }
  }

  async stop(): Promise<void> {
    const q = this.#query;
    if (!q) {
      this.#setStatus({ type: "stop" });
      return;
    }
    this.#closing = true;
    this.#failPendingPrompts("Unit stopped by operator");
    const turn = this.#pendingTurn;
    if (turn) {
      this.#pendingTurn = null;
      turn.resolve({ ok: false, text: "Stopped", interrupted: true, at: Date.now() });
    }
    this.#closeInput();
    try {
      q.close();
    } catch (err) {
      this.#log.debug({ err }, "close threw");
    }
    this.#query = null;
    this.#setActivity(undefined);
    this.#setStatus({ type: "stop" });
  }

  async submit(text: string, source: OrderSource): Promise<TurnResult> {
    if (!this.#query) throw new Error(`unit ${this.unitId} is offline`);
    if (this.#pendingTurn) throw new Error(`unit ${this.unitId} already has a turn in flight`);
    const at = Date.now();
    const result = new Promise<TurnResult>((resolve) => {
      this.#pendingTurn = { source, startedAt: at, resolve };
    });
    this.#stopCaptured = undefined;
    this.#interrupting = false;
    this.#events.emit("transcript", [{ kind: "user", at, text, source }]);
    this.#setStatus({ type: "submit" });
    this.#pushInput({
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      ...(this.#sessionId ? { session_id: this.#sessionId } : {}),
    });
    return result;
  }

  async interrupt(): Promise<void> {
    const q = this.#query;
    if (!q || !this.#pendingTurn) return;
    this.#interrupting = true;
    // A permission prompt cannot be interrupted cleanly; deny-with-interrupt is the SDK's escape hatch.
    if (this.#pendingPermission) {
      const p = this.#pendingPermission;
      this.#pendingPermission = null;
      this.#events.emit("permission", null);
      p.resolve({ behavior: "deny", message: "Interrupted by operator", interrupt: true });
    }
    if (this.#pendingQuestion) {
      const p = this.#pendingQuestion;
      this.#pendingQuestion = null;
      this.#events.emit("question", null);
      p.resolve({ behavior: "deny", message: "Interrupted by operator", interrupt: true });
    }
    const turnDone = new Promise<void>((resolve) => {
      const off = this.#events.on("result", () => {
        off();
        resolve();
      });
    });
    try {
      await q.interrupt();
    } catch (err) {
      this.#log.warn({ err, unitId: this.unitId }, "interrupt() threw");
    }
    const timeoutMs = this.#opts.interruptTimeoutMs ?? 15_000;
    await Promise.race([
      turnDone,
      new Promise<void>((resolve) =>
        setTimeout(() => {
          if (this.#pendingTurn) {
            this.#log.warn({ unitId: this.unitId }, "no result after interrupt; resolving turn as interrupted");
            this.#finishTurn({ ok: true, text: "", interrupted: true, at: Date.now() });
          }
          resolve();
        }, timeoutMs),
      ),
    ]);
  }

  answerPermission(answer: PermissionAnswer): boolean {
    const p = this.#pendingPermission;
    if (!p) return false;
    this.#pendingPermission = null;
    this.#events.emit("permission", null);
    if (answer.allow) {
      const result: PermissionResult = {
        behavior: "allow",
        updatedInput: answer.updatedInput ?? p.rawInput,
      };
      if (answer.remember && p.suggestions?.length) result.updatedPermissions = p.suggestions;
      p.resolve(result);
    } else {
      p.resolve({ behavior: "deny", message: answer.message ?? "Denied by operator" });
    }
    this.#setStatus({ type: "answered" });
    return true;
  }

  answerQuestion(answers: Record<string, string>): boolean {
    const p = this.#pendingQuestion;
    if (!p) return false;
    this.#pendingQuestion = null;
    this.#events.emit("question", null);
    p.resolve({ behavior: "allow", updatedInput: { ...p.rawInput, answers } });
    this.#setStatus({ type: "answered" });
    return true;
  }

  async setModel(model: string): Promise<void> {
    this.#model = model;
    if (this.#query) await this.#query.setModel(model);
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#permissionMode = mode;
    if (this.#query) await this.#query.setPermissionMode(mode);
  }

  async contextUsage(): Promise<number | undefined> {
    if (!this.#query) return undefined;
    try {
      const u = await this.#query.getContextUsage();
      if (typeof u?.percentage === "number") return u.percentage / 100;
      if (u?.maxTokens) return u.totalTokens / u.maxTokens;
    } catch (err) {
      this.#log.debug({ err }, "getContextUsage failed");
    }
    return undefined;
  }

  // --------------------------------------------------------------------- SDK wiring

  #buildOptions(): Options {
    const hooks = this.#mergeHooks(this.#opts.hooks);
    const mcpServers = this.#opts.mcpServers?.(this.#sdk);
    const options: Options = {
      cwd: this.#opts.cwd,
      model: this.#model,
      permissionMode: this.#permissionMode,
      systemPrompt: { type: "preset", preset: "claude_code", append: this.#opts.systemPromptAppend },
      settingSources: this.#opts.settingSources ?? ["user", "project", "local"],
      includePartialMessages: false,
      canUseTool: (toolName, input, ctx) => this.#canUseTool(toolName, input, ctx.suggestions, ctx.signal),
      hooks,
      stderr: (data: string) => this.#log.debug({ unitId: this.unitId, stderr: data.trimEnd() }),
    };
    if (mcpServers) options.mcpServers = mcpServers;
    if (this.#sessionId) options.resume = this.#sessionId;
    if (this.#opts.env) options.env = { ...process.env, ...this.#opts.env };
    if (this.#permissionMode === "bypassPermissions") options.allowDangerouslySkipPermissions = true;
    return options;
  }

  #mergeHooks(
    extra: Partial<Record<HookEvent, HookCallbackMatcher[]>> | undefined,
  ): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
    const stopCapture: HookCallbackMatcher = {
      hooks: [
        async (input) => {
          const text = (input as StopHookInput).last_assistant_message;
          if (typeof text === "string" && text) {
            this.#stopCaptured = text;
            this.#events.emit("stopCapture", text);
          }
          return { continue: true };
        },
      ],
    };
    const merged: Partial<Record<HookEvent, HookCallbackMatcher[]>> = { ...(extra ?? {}) };
    merged.Stop = [...(merged.Stop ?? []), stopCapture];
    return merged;
  }

  async *#inputIterable(): AsyncGenerator<SDKUserMessage> {
    while (!this.#inputClosed) {
      const next = this.#input.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        this.#inputWake = resolve;
      });
      this.#inputWake = null;
    }
  }

  #pushInput(msg: SDKUserMessage): void {
    this.#input.push(msg);
    this.#inputWake?.();
  }

  #closeInput(): void {
    this.#inputClosed = true;
    this.#inputWake?.();
  }

  async #pump(q: Query): Promise<void> {
    try {
      for await (const msg of q) {
        if (this.#query !== q) break;
        try {
          this.#handle(msg);
        } catch (err) {
          this.#log.error({ err, unitId: this.unitId, type: msg.type }, "failed handling SDK message");
        }
      }
      this.#onExit(undefined, q);
    } catch (err) {
      this.#onExit(err instanceof Error ? err : new Error(String(err)), q);
    }
  }

  #onExit(err: Error | undefined, q: Query): void {
    if (this.#query !== null && this.#query !== q) return; // a newer session replaced this one
    const wasClosing = this.#closing;
    this.#query = null;
    this.#closeInput();
    if (this.#startWaiters) {
      const w = this.#startWaiters;
      this.#startWaiters = null;
      w.reject(err ?? new Error(`unit ${this.unitId}: session ended during startup`));
    }
    this.#failPendingPrompts(err ? `Session crashed: ${err.message}` : "Session ended");
    const turn = this.#pendingTurn;
    if (turn) {
      this.#pendingTurn = null;
      const text = err ? `Session crashed: ${err.message}` : "Session ended";
      this.#setStatus({ type: "crash" });
      this.#events.emit("transcript", [{ kind: "system", at: Date.now(), text }]);
      this.#events.emit("result", { ok: false, text, errors: [text], at: Date.now() });
      turn.resolve({ ok: false, text, errors: [text], at: Date.now() });
    } else {
      this.#setStatus(wasClosing || !err ? { type: "stop" } : { type: "crash" });
      if (err) this.#events.emit("transcript", [{ kind: "system", at: Date.now(), text: `Session ended: ${err.message}` }]);
    }
    this.#setActivity(undefined);
    if (err && !wasClosing) this.#log.error({ err, unitId: this.unitId }, "unit session ended with error");
    this.#events.emit("exit", wasClosing ? undefined : err);
  }

  #failPendingPrompts(reason: string): void {
    if (this.#pendingPermission) {
      const p = this.#pendingPermission;
      this.#pendingPermission = null;
      this.#events.emit("permission", null);
      p.resolve({ behavior: "deny", message: reason });
    }
    if (this.#pendingQuestion) {
      const p = this.#pendingQuestion;
      this.#pendingQuestion = null;
      this.#events.emit("question", null);
      p.resolve({ behavior: "deny", message: reason });
    }
  }

  #handle(msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        this.#handleSystem(msg as SDKMessage & { type: "system"; subtype: string });
        return;
      case "assistant": {
        if (msg.parent_tool_use_id) return; // subagent chatter stays out of the unit transcript
        const blocks = (msg.message.content ?? []) as unknown as ContentBlock[];
        const at = Date.now();
        const entries: TranscriptEntry[] = transcriptFromAssistantBlocks(blocks, at);
        if (entries.length) this.#events.emit("transcript", entries);
        const activity = activityFromBlocks(blocks);
        if (activity) this.#setActivity(activity);
        return;
      }
      case "user": {
        if ((msg as { isReplay?: boolean }).isReplay) return;
        if (msg.parent_tool_use_id) return;
        const content = msg.message.content;
        if (!Array.isArray(content)) return;
        const at = Date.now();
        for (const r of toolResultsFromUserBlocks(content as unknown as ContentBlock[])) {
          this.#events.emit("toolResult", { ...r, at });
        }
        return;
      }
      case "result": {
        const at = Date.now();
        const ok = msg.subtype === "success" && !msg.is_error;
        const text =
          (msg.subtype === "success" ? msg.result : "") ||
          this.#stopCaptured ||
          (msg.subtype !== "success" ? msg.errors.join("\n") : "") ||
          "";
        const result: TurnResult = {
          ok,
          text,
          costUsd: msg.total_cost_usd,
          durationMs: msg.duration_ms,
          interrupted: this.#interrupting || undefined,
          at,
        };
        if (msg.subtype !== "success") result.errors = msg.errors;
        this.#events.emit("transcript", [
          { kind: "result", at, ok, text: text.slice(0, 4000), costUsd: msg.total_cost_usd, durationMs: msg.duration_ms },
        ]);
        this.#finishTurn(result);
        return;
      }
      case "rate_limit_event": {
        // Emitted on every turn as plain status; only warn when the API is actually throttling.
        const info = (msg as unknown as { rate_limit_info?: { status?: string } }).rate_limit_info;
        const status = info?.status ?? "allowed";
        if (status !== "allowed" && !this.#rateLimitNoticed) {
          this.#rateLimitNoticed = true;
          this.#events.emit("notice", `API rate limit status: ${status}.`, "info");
        } else if (status === "allowed") {
          this.#rateLimitNoticed = false;
        }
        return;
      }
      default:
        return;
    }
  }

  #handleSystem(msg: SDKMessage & { type: "system"; subtype: string }): void {
    switch (msg.subtype) {
      case "init": {
        const init = msg as unknown as {
          session_id: string;
          model: string;
          tools: string[];
          mcp_servers: { name: string; status: string }[];
          permissionMode?: string;
        };
        this.#sessionId = init.session_id;
        const info: InitInfo = {
          sessionId: init.session_id,
          model: init.model,
          tools: init.tools ?? [],
          mcpServers: init.mcp_servers ?? [],
          permissionMode: init.permissionMode,
        };
        this.#initInfo = info;
        this.#setStatus({ type: "init" });
        this.#events.emit("init", info);
        for (const s of info.mcpServers) {
          if (s.name === "fleet" && s.status !== "connected") {
            this.#events.emit("notice", `fleet MCP server status: ${s.status}`, "error");
          }
        }
        return;
      }
      case "compact_boundary": {
        const meta = (msg as unknown as { compact_metadata?: { trigger?: string; pre_tokens?: number } }).compact_metadata;
        this.#events.emit("transcript", [
          {
            kind: "system",
            at: Date.now(),
            text: `Context compacted (${meta?.trigger ?? "auto"}${meta?.pre_tokens ? `, ${meta.pre_tokens} tokens before` : ""})`,
          },
        ]);
        return;
      }
      case "api_retry": {
        this.#retryCount += 1;
        const activity = activityFromSystem(msg as unknown as Record<string, unknown>);
        if (activity) this.#setActivity(activity);
        if (this.#retryCount === 3) this.#events.emit("notice", "API request retried 3 times; check connectivity or rate limits.", "info");
        return;
      }
      case "status": {
        const activity = activityFromSystem(msg as unknown as Record<string, unknown>);
        if (activity) this.#setActivity(activity);
        return;
      }
      default:
        return;
    }
  }

  #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    suggestions: PermissionUpdate[] | undefined,
    signal: AbortSignal,
  ): Promise<PermissionResult> {
    const at = Date.now();
    if (toolName === "AskUserQuestion") {
      const raw = input as { questions?: unknown };
      const questions = Array.isArray(raw.questions)
        ? (raw.questions as Record<string, unknown>[]).map((q) => ({
            question: String(q.question ?? ""),
            header: typeof q.header === "string" ? q.header : undefined,
            multiSelect: typeof q.multiSelect === "boolean" ? q.multiSelect : undefined,
            options: Array.isArray(q.options)
              ? (q.options as Record<string, unknown>[]).map((o) => ({
                  label: String(o.label ?? ""),
                  description: typeof o.description === "string" ? o.description : undefined,
                }))
              : [],
          }))
        : [];
      const question: PendingQuestion = { toolUseId: nanoid(10), questions, at };
      return new Promise<PermissionResult>((resolve) => {
        this.#pendingQuestion = { question, rawInput: input, resolve };
        this.#setStatus({ type: "wait" });
        this.#events.emit("question", question);
        signal.addEventListener(
          "abort",
          () => {
            if (this.#pendingQuestion?.question === question) {
              this.#pendingQuestion = null;
              this.#events.emit("question", null);
              resolve({ behavior: "deny", message: "Aborted" });
            }
          },
          { once: true },
        );
      });
    }

    const request: PermissionRequest = {
      requestId: nanoid(10),
      toolName,
      input: summarizeInput(input),
      summary: summarizePermission(toolName, input),
      suggestions: suggestions as unknown[] | undefined,
      at,
    };
    return new Promise<PermissionResult>((resolve) => {
      this.#pendingPermission = { request, rawInput: input, suggestions, resolve };
      this.#setStatus({ type: "wait" });
      this.#events.emit("permission", request);
      signal.addEventListener(
        "abort",
        () => {
          if (this.#pendingPermission?.request === request) {
            this.#pendingPermission = null;
            this.#events.emit("permission", null);
            resolve({ behavior: "deny", message: "Aborted" });
          }
        },
        { once: true },
      );
    });
  }

  // --------------------------------------------------------------------- state helpers

  #finishTurn(result: TurnResult): void {
    const turn = this.#pendingTurn;
    this.#pendingTurn = null;
    this.#interrupting = false;
    this.#setActivity(undefined);
    this.#setStatus({ type: "result", ok: result.ok });
    this.#events.emit("result", result);
    turn?.resolve(result);
  }

  #setStatus(event: StatusEvent): void {
    const next = nextStatus(this.#status, event);
    if (next === this.#status) return;
    this.#status = next;
    this.#events.emit("status", next, Date.now());
  }

  #activity: string | undefined;
  #setActivity(activity: string | undefined): void {
    if (activity === this.#activity) return;
    this.#activity = activity;
    this.#events.emit("activity", activity);
  }

  /** For tests and diagnostics. */
  get initInfo(): InitInfo | null {
    return this.#initInfo;
  }
}
