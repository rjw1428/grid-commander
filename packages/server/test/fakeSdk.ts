/**
 * Fake Agent SDK mirroring the `query()` surface used by UnitRuntime:
 * async generator of SDKMessages + interrupt()/setModel()/setPermissionMode()/close(),
 * canUseTool invocation with an AbortSignal, and PostToolUse/Stop hook callbacks.
 *
 * A scenario is an async generator per user turn that yields SDK messages and may await
 * ctx.ask() (permission) or ctx.waitForInterrupt().
 */
import { nanoid } from "nanoid";
import type {
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  Options,
  PermissionResult,
  SDKMessage,
  SDKUserMessage,
} from "../src/runtime/sdkTypes.js";
import type { SdkFacade } from "../src/runtime/UnitRuntime.js";

type UUID = `${string}-${string}-${string}-${string}-${string}`;
const uuid = (): UUID => crypto.randomUUID() as UUID;

export interface FakeTurnCtx {
  turn: number;
  text: string;
  sessionId: string;
  options: Options;
  interrupted: boolean;
  /** Invoke options.canUseTool exactly like the CLI would. */
  ask(toolName: string, input: Record<string, unknown>): Promise<PermissionResult>;
  waitForInterrupt(): Promise<void>;
  runHook(event: HookEvent, input: Partial<HookInput> & Record<string, unknown>): Promise<string[]>;
  msg: {
    assistantText(text: string): SDKMessage;
    thinking(): SDKMessage;
    toolUse(name: string, input: Record<string, unknown>, id?: string): SDKMessage;
    toolResult(toolUseId: string, ok: boolean, content?: string): SDKMessage;
    result(ok: boolean, text: string, extra?: Record<string, unknown>): SDKMessage;
    apiRetry(attempt: number): SDKMessage;
    compactBoundary(): SDKMessage;
  };
}

export type FakeTurnScript = (ctx: FakeTurnCtx) => AsyncGenerator<SDKMessage, void, unknown>;

export interface FakeSdkOptions {
  /** Script per turn; the last one repeats. */
  turns: FakeTurnScript[];
  sessionId?: string;
  /** Throw before init (startup failure). */
  failInit?: boolean;
  /** Milliseconds before init is emitted. */
  initDelayMs?: number;
  mcpStatus?: string;
}

export interface FakeQueryHandle {
  options: Options;
  received: SDKUserMessage[];
  interrupts: number;
  closed: boolean;
  modelChanges: string[];
  permissionModeChanges: string[];
  hookCalls: { event: HookEvent; input: unknown; output: unknown }[];
}

class AsyncQueue<T> {
  #items: T[] = [];
  #waiters: { resolve: (r: IteratorResult<T>) => void; reject: (e: unknown) => void }[] = [];
  #done = false;
  #error: unknown = undefined;

  push(item: T) {
    if (this.#done) return;
    const w = this.#waiters.shift();
    if (w) w.resolve({ value: item, done: false });
    else this.#items.push(item);
  }
  fail(err: unknown) {
    if (this.#done) return;
    this.#error = err;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.reject(err);
  }
  end() {
    if (this.#done) return;
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w.resolve({ value: undefined as never, done: true });
  }
  get hasError() {
    return this.#error !== undefined;
  }
  get error() {
    return this.#error;
  }
  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.#done) {
      if (this.#error !== undefined) return Promise.reject(this.#error);
      return Promise.resolve({ value: undefined as never, done: true });
    }
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}

export function createFakeSdk(opts: FakeSdkOptions): SdkFacade & { handles: FakeQueryHandle[] } {
  const handles: FakeQueryHandle[] = [];
  const sessionId = opts.sessionId ?? uuid();

  const fakeQuery = (params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: Options }) => {
    const options = params.options ?? {};
    const out = new AsyncQueue<SDKMessage>();
    const handle: FakeQueryHandle = {
      options,
      received: [],
      interrupts: 0,
      closed: false,
      modelChanges: [],
      permissionModeChanges: [],
      hookCalls: [],
    };
    handles.push(handle);

    let interruptWaiters: (() => void)[] = [];
    let interrupted = false;
    let currentAbort: AbortController | null = null;

    const runHook = async (event: HookEvent, input: Partial<HookInput> & Record<string, unknown>) => {
      const matchers = (options.hooks?.[event] ?? []) as HookCallbackMatcher[];
      const contexts: string[] = [];
      const full = {
        session_id: sessionId,
        transcript_path: "/dev/null",
        cwd: options.cwd ?? process.cwd(),
        hook_event_name: event,
        ...input,
      } as unknown as HookInput;
      for (const m of matchers) {
        if (m.matcher && "tool_name" in full && !new RegExp(m.matcher).test(String(full.tool_name))) continue;
        for (const h of m.hooks) {
          const output = await h(full, undefined, { signal: new AbortController().signal });
          handle.hookCalls.push({ event, input: full, output });
          const ctx = (output as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput
            ?.additionalContext;
          if (ctx) contexts.push(ctx);
        }
      }
      return contexts;
    };

    const emitInit = () => {
      out.push({
        type: "system",
        subtype: "init",
        apiKeySource: "none",
        claude_code_version: "fake",
        cwd: options.cwd ?? process.cwd(),
        tools: ["Bash", "Read", "Edit", "Write", "AskUserQuestion"],
        mcp_servers: options.mcpServers
          ? Object.keys(options.mcpServers).map((name) => ({ name, status: opts.mcpStatus ?? "connected" }))
          : [],
        model: options.model ?? "fake-model",
        permissionMode: options.permissionMode ?? "default",
        slash_commands: [],
        output_style: "default",
        skills: [],
        plugins: [],
        uuid: uuid(),
        session_id: sessionId,
      } as unknown as SDKMessage);
    };

    const consume = async () => {
      if (opts.failInit) {
        out.fail(new Error("fake startup failure"));
        return;
      }
      if (opts.initDelayMs) await new Promise((r) => setTimeout(r, opts.initDelayMs));
      emitInit();
      if (typeof params.prompt === "string") {
        await runTurn(0, params.prompt);
        out.end();
        return;
      }
      let turn = 0;
      try {
        for await (const um of params.prompt) {
          if (handle.closed) break;
          handle.received.push(um);
          const text =
            typeof um.message.content === "string"
              ? um.message.content
              : (um.message.content as { type: string; text?: string }[])
                  .filter((b) => b.type === "text")
                  .map((b) => b.text ?? "")
                  .join("\n");
          await runTurn(turn++, text);
          if (out.hasError) return;
        }
        out.end();
      } catch (err) {
        out.fail(err);
      }
    };

    const runTurn = async (turn: number, text: string) => {
      const script = opts.turns[Math.min(turn, opts.turns.length - 1)];
      if (!script) throw new Error("fake sdk: no turn script");
      interrupted = false;
      let lastAssistant = "";
      const ctx: FakeTurnCtx = {
        turn,
        text,
        sessionId,
        options,
        get interrupted() {
          return interrupted;
        },
        ask: async (toolName, input) => {
          if (!options.canUseTool) return { behavior: "allow", updatedInput: input };
          currentAbort = new AbortController();
          try {
            return await options.canUseTool(toolName, input, {
              signal: currentAbort.signal,
              suggestions: [{ type: "addRules", rules: [{ toolName }], behavior: "allow", destination: "session" }],
            });
          } finally {
            currentAbort = null;
          }
        },
        waitForInterrupt: () =>
          interrupted ? Promise.resolve() : new Promise<void>((resolve) => interruptWaiters.push(resolve)),
        runHook,
        msg: {
          assistantText: (t) => {
            lastAssistant = t;
            return {
              type: "assistant",
              message: { id: "msg_" + nanoid(6), role: "assistant", model: options.model ?? "fake", content: [{ type: "text", text: t }] },
              parent_tool_use_id: null,
              uuid: uuid(),
              session_id: sessionId,
            } as unknown as SDKMessage;
          },
          thinking: () =>
            ({
              type: "assistant",
              message: { id: "msg_" + nanoid(6), role: "assistant", model: options.model ?? "fake", content: [{ type: "thinking", thinking: "..." }] },
              parent_tool_use_id: null,
              uuid: uuid(),
              session_id: sessionId,
            }) as unknown as SDKMessage,
          toolUse: (name, input, id = "toolu_" + nanoid(6)) =>
            ({
              type: "assistant",
              message: { id: "msg_" + nanoid(6), role: "assistant", model: options.model ?? "fake", content: [{ type: "tool_use", id, name, input }] },
              parent_tool_use_id: null,
              uuid: uuid(),
              session_id: sessionId,
            }) as unknown as SDKMessage,
          toolResult: (toolUseId, ok, content = ok ? "ok" : "failed") =>
            ({
              type: "user",
              message: { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, is_error: !ok, content }] },
              parent_tool_use_id: null,
              uuid: uuid(),
              session_id: sessionId,
            }) as unknown as SDKMessage,
          result: (ok, t, extra = {}) =>
            ({
              type: "result",
              subtype: ok ? "success" : "error_during_execution",
              duration_ms: 10,
              duration_api_ms: 5,
              is_error: !ok,
              num_turns: 1,
              stop_reason: "end_turn",
              total_cost_usd: 0.001,
              usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
              modelUsage: {},
              permission_denials: [],
              uuid: uuid(),
              session_id: sessionId,
              ...(ok ? { result: t } : { errors: [t] }),
              ...extra,
            }) as unknown as SDKMessage,
          apiRetry: (attempt) =>
            ({
              type: "system",
              subtype: "api_retry",
              attempt,
              max_retries: 10,
              retry_delay_ms: 100,
              error_status: 529,
              error: "server_error",
              uuid: uuid(),
              session_id: sessionId,
            }) as unknown as SDKMessage,
          compactBoundary: () =>
            ({
              type: "system",
              subtype: "compact_boundary",
              compact_metadata: { trigger: "manual", pre_tokens: 1000 },
              uuid: uuid(),
              session_id: sessionId,
            }) as unknown as SDKMessage,
        },
      };

      for await (const m of script(ctx)) {
        if (handle.closed) return;
        out.push(m);
        // mimic the CLI: PostToolUse after each tool_result
        if (m.type === "user") {
          const blocks = (m as { message: { content: unknown } }).message.content;
          if (Array.isArray(blocks)) {
            for (const b of blocks as { type: string; tool_use_id?: string }[]) {
              if (b.type === "tool_result") {
                const ctxs = await runHook("PostToolUse", {
                  tool_name: "Bash",
                  tool_input: {},
                  tool_response: {},
                  tool_use_id: b.tool_use_id ?? "",
                });
                if (ctxs.length) ctx.text += "\n" + ctxs.join("\n");
              }
            }
          }
        }
        if (m.type === "result") {
          // The real CLI fires Stop before the result is written.
          await runHook("Stop", { stop_hook_active: false, last_assistant_message: lastAssistant });
        }
      }
    };

    void consume();

    const gen = {
      next: () => out.next(),
      return: async () => {
        handle.closed = true;
        out.end();
        return { value: undefined, done: true } as IteratorResult<SDKMessage>;
      },
      throw: async (e: unknown) => {
        out.fail(e);
        throw e;
      },
      [Symbol.asyncIterator]() {
        return gen;
      },
      [Symbol.asyncDispose]: async () => {},
      interrupt: async () => {
        handle.interrupts += 1;
        interrupted = true;
        currentAbort?.abort();
        for (const w of interruptWaiters.splice(0)) w();
        return undefined;
      },
      setModel: async (m?: string) => {
        handle.modelChanges.push(m ?? "");
      },
      setPermissionMode: async (m: string) => {
        handle.permissionModeChanges.push(m);
      },
      getContextUsage: async () => ({ percentage: 42, totalTokens: 42_000, maxTokens: 100_000 }),
      mcpServerStatus: async () => [],
      supportedModels: async () => [],
      close: () => {
        handle.closed = true;
        out.end();
      },
    };
    return gen as unknown as ReturnType<SdkFacade["query"]>;
  };

  const facade: SdkFacade & { handles: FakeQueryHandle[] } = {
    query: fakeQuery as unknown as SdkFacade["query"],
    createSdkMcpServer: ((o: { name: string; tools?: unknown[] }) => ({
      type: "sdk",
      name: o.name,
      instance: { __fakeTools: o.tools ?? [] },
    })) as unknown as SdkFacade["createSdkMcpServer"],
    tool: ((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
      name,
      description,
      inputSchema,
      handler,
    })) as unknown as SdkFacade["tool"],
    handles,
  };
  return facade;
}

// ----------------------------------------------------------------------------- canned scripts

export const scripts = {
  happy: (reply = "ready"): FakeTurnScript =>
    async function* (ctx) {
      yield ctx.msg.thinking();
      yield ctx.msg.assistantText(reply);
      yield ctx.msg.result(true, reply);
    },
  permission: (command = "ls -la"): FakeTurnScript =>
    async function* (ctx) {
      const id = "toolu_perm";
      yield ctx.msg.toolUse("Bash", { command }, id);
      const r = await ctx.ask("Bash", { command });
      if (r.behavior === "allow") {
        yield ctx.msg.toolResult(id, true, "file1\nfile2");
        yield ctx.msg.assistantText("Listed the directory.");
        yield ctx.msg.result(true, "Listed the directory.");
      } else {
        yield ctx.msg.toolResult(id, false, r.message);
        yield ctx.msg.assistantText("Understood, skipping that command.");
        yield ctx.msg.result(true, "Understood, skipping that command.");
      }
    },
  question: (): FakeTurnScript =>
    async function* (ctx) {
      const id = "toolu_q";
      const input = {
        questions: [
          {
            question: "Which database?",
            header: "Database",
            options: [
              { label: "SQLite", description: "single file" },
              { label: "Postgres", description: "server" },
            ],
            multiSelect: false,
          },
        ],
      };
      yield ctx.msg.toolUse("AskUserQuestion", input, id);
      const r = await ctx.ask("AskUserQuestion", input);
      if (r.behavior === "allow") {
        const answers = (r.updatedInput as { answers?: Record<string, string> }).answers ?? {};
        yield ctx.msg.toolResult(id, true, JSON.stringify(answers));
        const choice = answers["Which database?"] ?? "?";
        yield ctx.msg.assistantText(`Going with ${choice}.`);
        yield ctx.msg.result(true, `Going with ${choice}.`);
      } else {
        yield ctx.msg.toolResult(id, false, r.message);
        yield ctx.msg.result(true, "No answer.");
      }
    },
  interruptible: (): FakeTurnScript =>
    async function* (ctx) {
      yield ctx.msg.assistantText("Working on a long task…");
      await ctx.waitForInterrupt();
      yield ctx.msg.result(true, "[Request interrupted by user]");
    },
  crash: (): FakeTurnScript =>
    async function* (ctx) {
      yield ctx.msg.assistantText("about to crash");
      throw new Error("boom: fake process died");
    },
  errorResult: (): FakeTurnScript =>
    async function* (ctx) {
      yield ctx.msg.assistantText("hmm");
      yield ctx.msg.result(false, "max turns reached");
    },
  retries: (): FakeTurnScript =>
    async function* (ctx) {
      yield ctx.msg.apiRetry(1);
      yield ctx.msg.apiRetry(2);
      yield ctx.msg.apiRetry(3);
      yield ctx.msg.compactBoundary();
      yield ctx.msg.assistantText("eventually");
      yield ctx.msg.result(true, "eventually");
    },
};
