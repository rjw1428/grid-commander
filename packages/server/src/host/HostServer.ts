/**
 * The unit host: owns Runtime instances so that Claude sessions outlive the web server. Exactly one
 * hub is attached at a time (a new connection replaces the old one). Events emitted while no hub is
 * attached are buffered per unit and replayed on the next attach, so transcripts and results are
 * not lost across a hub restart.
 */
import { createServer, connect as netConnect, type Server, type Socket } from "node:net";
import { existsSync, unlinkSync } from "node:fs";
import { nanoid } from "nanoid";
import type { PendingQuestion, PermissionRequest, UnitStatus } from "@gridcommander/shared";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { Runtime } from "../runtime/Runtime.js";
import {
  encodeFrame,
  FrameParser,
  HOST_PROTOCOL_VERSION,
  HubRequestSchema,
  type HelloReply,
  type HostedUnit,
  type HubRequest,
  type RuntimeEvent,
  type UnitSpec,
} from "./protocol.js";

/** Calls a runtime can make back into the hub (fleet tools, inbox nudge). */
export interface HostBridge {
  tool(name: string, args: Record<string, unknown>): Promise<unknown>;
  nudge(): Promise<string | undefined>;
}

export type HostRuntimeFactory = (spec: UnitSpec, bridge: HostBridge) => Runtime;

export interface HostServerOptions {
  socketPath: string;
  factory: HostRuntimeFactory;
  log: RuntimeLogger;
  version: string;
  /** Max buffered events per unit while detached; oldest are dropped past this. */
  bufferLimit?: number;
  /** How long a bridge call waits for a hub to (re)attach before failing. */
  bridgeTimeoutMs?: number;
  /** Exit when no hub has been attached and no unit is running for this long. 0 disables. */
  idleExitMs?: number;
  onIdleExit?: () => void;
  /** Called after a `shutdown` request has stopped every unit. */
  onShutdown?: () => void;
}

interface Hosted {
  spec: UnitSpec;
  rt: Runtime;
  unsubs: (() => void)[];
  buffered: RuntimeEvent[];
  dropped: number;
  activity?: string;
  pendingPermission?: PermissionRequest;
  pendingQuestion?: PendingQuestion;
  exited: boolean;
}

interface PendingBridge {
  id: string;
  unitId: string;
  kind: "tool" | "nudge";
  name: string;
  args: Record<string, unknown>;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class HostServer {
  readonly startedAt = Date.now();
  #opts: HostServerOptions;
  #log: RuntimeLogger;
  #server: Server | null = null;
  #hub: Socket | null = null;
  #units = new Map<string, Hosted>();
  #bridges = new Map<string, PendingBridge>();
  #lastHubAt = Date.now();
  #idleTimer: NodeJS.Timeout | null = null;
  #closing = false;

  constructor(opts: HostServerOptions) {
    this.#opts = opts;
    this.#log = opts.log;
  }

  get attached(): boolean {
    return this.#hub !== null;
  }
  get unitIds(): string[] {
    return [...this.#units.keys()];
  }
  runtime(unitId: string): Runtime | undefined {
    return this.#units.get(unitId)?.rt;
  }

  async listen(): Promise<void> {
    await this.#clearStaleSocket();
    const server = createServer((sock) => this.#onConnection(sock));
    this.#server = server;
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.#opts.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    server.on("error", (err) => this.#log.error({ err }, "host socket error"));
    const idleMs = this.#opts.idleExitMs ?? 0;
    if (idleMs > 0) {
      this.#idleTimer = setInterval(() => {
        if (this.#hub || this.#units.size > 0) return;
        if (Date.now() - this.#lastHubAt >= idleMs) {
          this.#log.info("no hub attached and no units running; exiting");
          this.#opts.onIdleExit?.();
        }
      }, Math.min(idleMs, 30_000));
      this.#idleTimer.unref?.();
    }
    this.#log.info({ socket: this.#opts.socketPath, pid: process.pid }, "unit host listening");
  }

  /** Sever the hub connection without notice, as a crash would. For tests. */
  dropHub(): void {
    const s = this.#hub;
    this.#hub = null;
    s?.destroy();
  }

  /** Stop every unit and close the socket. */
  async close(opts: { announce?: boolean } = {}): Promise<void> {
    this.#closing = true;
    if (this.#idleTimer) clearInterval(this.#idleTimer);
    const live = [...this.#units.values()].filter((h) => !h.exited).map((h) => h.spec.unitId);
    if (live.length && this.#hub && opts.announce !== false) {
      // tell the hub these exits are the host going away, not units finishing, so it recovers them
      this.#send(this.#hub, { type: "closing", units: live });
      await new Promise<void>((resolve) => (this.#hub ? this.#hub.write("", () => resolve()) : resolve()));
    }
    await Promise.allSettled([...this.#units.values()].map((h) => h.rt.stop()));
    for (const b of this.#bridges.values()) {
      clearTimeout(b.timer);
      b.reject(new Error("unit host shutting down"));
    }
    this.#bridges.clear();
    this.#hub?.destroy();
    this.#hub = null;
    await new Promise<void>((resolve) => {
      if (!this.#server) return resolve();
      this.#server.close(() => resolve());
    });
    this.#server = null;
    if (existsSync(this.#opts.socketPath)) {
      try {
        unlinkSync(this.#opts.socketPath);
      } catch {
        /* ignore */
      }
    }
  }

  // --------------------------------------------------------------------- connection

  async #clearStaleSocket(): Promise<void> {
    const path = this.#opts.socketPath;
    if (!existsSync(path)) return;
    const alive = await new Promise<boolean>((resolve) => {
      const s = netConnect(path);
      s.once("connect", () => {
        s.destroy();
        resolve(true);
      });
      s.once("error", () => resolve(false));
    });
    if (alive) throw new Error(`another unit host is already listening on ${path}`);
    unlinkSync(path);
  }

  #onConnection(sock: Socket): void {
    if (this.#hub) {
      this.#log.warn("a second hub connected; replacing the previous attachment");
      this.#hub.destroy();
    }
    this.#hub = sock;
    this.#lastHubAt = Date.now();
    sock.setEncoding("utf8");
    const parser = new FrameParser();
    sock.on("data", (chunk: string) => {
      for (const raw of parser.push(chunk, (line) => this.#log.warn({ line: line.slice(0, 200) }, "bad frame from hub"))) {
        const parsed = HubRequestSchema.safeParse(raw);
        if (!parsed.success) {
          this.#log.warn({ issue: parsed.error.issues[0]?.message }, "invalid request from hub");
          continue;
        }
        void this.#dispatch(sock, parsed.data);
      }
    });
    const onGone = () => {
      if (this.#hub !== sock) return;
      this.#hub = null;
      this.#lastHubAt = Date.now();
      this.#log.info({ units: this.#units.size }, "hub detached; buffering events");
    };
    sock.on("close", onGone);
    sock.on("error", (err) => {
      this.#log.debug({ err }, "hub socket error");
      onGone();
    });
  }

  #send(sock: Socket | null, msg: unknown): boolean {
    if (!sock || sock.destroyed) return false;
    try {
      sock.write(encodeFrame(msg));
      return true;
    } catch (err) {
      this.#log.debug({ err }, "write to hub failed");
      return false;
    }
  }

  #reply(sock: Socket, id: string, ok: boolean, value?: unknown, error?: string): void {
    this.#send(sock, { type: "reply", id, ok, ...(value !== undefined ? { value } : {}), ...(error ? { error } : {}) });
  }

  async #dispatch(sock: Socket, req: HubRequest): Promise<void> {
    try {
      switch (req.type) {
        case "hello": {
          if (req.protocol !== HOST_PROTOCOL_VERSION) {
            this.#reply(sock, req.id, false, undefined, `protocol mismatch: hub ${req.protocol}, host ${HOST_PROTOCOL_VERSION}`);
            return;
          }
          const units: HostedUnit[] = [...this.#units.values()].map((h) => this.#snapshot(h));
          const reply: HelloReply = { protocol: HOST_PROTOCOL_VERSION, hostVersion: this.#opts.version, pid: process.pid, startedAt: this.startedAt, units };
          this.#reply(sock, req.id, true, reply);
          // buffered events are now the hub's; exited units have been reported and can go
          for (const [id, h] of this.#units) {
            h.buffered = [];
            h.dropped = 0;
            if (h.exited) this.#units.delete(id);
          }
          // bridge calls that were waiting for a hub are re-issued to the new one
          for (const b of this.#bridges.values()) this.#send(sock, { type: "bridge", id: b.id, unitId: b.unitId, kind: b.kind, name: b.name, args: b.args });
          this.#log.info({ hubVersion: req.hubVersion, units: units.length }, "hub attached");
          return;
        }
        case "start": {
          const { spec } = req;
          const existing = this.#units.get(spec.unitId);
          if (existing && !existing.exited) {
            this.#reply(sock, req.id, false, undefined, `unit ${spec.unitId} is already hosted`);
            return;
          }
          if (existing) this.#units.delete(spec.unitId);
          const h = this.#host(spec);
          try {
            await h.rt.start();
          } catch (err) {
            this.#forget(spec.unitId);
            this.#reply(sock, req.id, false, undefined, err instanceof Error ? err.message : String(err));
            return;
          }
          this.#reply(sock, req.id, true, { status: h.rt.status, sessionId: h.rt.sessionId });
          return;
        }
        case "stop": {
          const h = this.#units.get(req.unitId);
          if (!h) {
            this.#reply(sock, req.id, true);
            return;
          }
          await h.rt.stop();
          this.#forget(req.unitId);
          this.#reply(sock, req.id, true);
          return;
        }
        case "submit": {
          const h = this.#need(req.unitId);
          // the turn result reaches the hub as a `result` event, so the reply only acknowledges acceptance
          const p = h.rt.submit(req.text, req.source);
          p.catch((err) => this.#log.warn({ err, unitId: req.unitId }, "turn failed"));
          this.#reply(sock, req.id, true);
          return;
        }
        case "interrupt": {
          await this.#need(req.unitId).rt.interrupt();
          this.#reply(sock, req.id, true);
          return;
        }
        case "answerPermission": {
          this.#reply(sock, req.id, true, this.#need(req.unitId).rt.answerPermission(req.answer));
          return;
        }
        case "answerQuestion": {
          this.#reply(sock, req.id, true, this.#need(req.unitId).rt.answerQuestion(req.answers));
          return;
        }
        case "setModel": {
          await this.#need(req.unitId).rt.setModel(req.model);
          this.#reply(sock, req.id, true);
          return;
        }
        case "setPermissionMode": {
          await this.#need(req.unitId).rt.setPermissionMode(req.mode);
          this.#reply(sock, req.id, true);
          return;
        }
        case "contextUsage": {
          this.#reply(sock, req.id, true, await this.#need(req.unitId).rt.contextUsage());
          return;
        }
        case "bridgeResult": {
          const b = this.#bridges.get(req.id);
          if (!b) return;
          this.#bridges.delete(req.id);
          clearTimeout(b.timer);
          if (req.ok) b.resolve(req.value);
          else b.reject(new Error(req.error ?? "bridge call failed"));
          return;
        }
        case "shutdown": {
          this.#log.info("shutdown requested by hub");
          this.#reply(sock, req.id, true);
          await this.close();
          this.#opts.onShutdown?.();
          return;
        }
      }
    } catch (err) {
      this.#reply(sock, req.id, false, undefined, err instanceof Error ? err.message : String(err));
    }
  }

  #need(unitId: string): Hosted {
    const h = this.#units.get(unitId);
    if (!h || h.exited) throw new Error(`unit ${unitId} is not hosted`);
    return h;
  }

  // --------------------------------------------------------------------- units

  #host(spec: UnitSpec): Hosted {
    const bridge: HostBridge = {
      tool: (name, args) => this.#bridge(spec.unitId, "tool", name, args),
      nudge: async () => {
        const v = await this.#bridge(spec.unitId, "nudge", "nudge", {});
        return typeof v === "string" ? v : undefined;
      },
    };
    const rt = this.#opts.factory(spec, bridge);
    const h: Hosted = { spec, rt, unsubs: [], buffered: [], dropped: 0, exited: false };
    this.#units.set(spec.unitId, h);
    const push = (ev: RuntimeEvent) => this.#emit(h, ev);
    h.unsubs.push(
      rt.on("status", (status, at) => push({ name: "status", status, at })),
      rt.on("activity", (activity) => {
        h.activity = activity;
        push({ name: "activity", activity });
      }),
      rt.on("transcript", (entries) => push({ name: "transcript", entries })),
      rt.on("toolResult", (r) => push({ name: "toolResult", ...r })),
      rt.on("permission", (request) => {
        h.pendingPermission = request ?? undefined;
        push({ name: "permission", request });
      }),
      rt.on("question", (question) => {
        h.pendingQuestion = question ?? undefined;
        push({ name: "question", question });
      }),
      rt.on("init", (info) => {
        h.spec = { ...h.spec, sessionId: info.sessionId };
        push({ name: "init", info });
      }),
      rt.on("result", (result) => push({ name: "result", result })),
      rt.on("stopCapture", (text) => push({ name: "stopCapture", text })),
      rt.on("notice", (text, severity) => push({ name: "notice", text, severity })),
      rt.on("exit", (error) => {
        h.exited = true;
        h.activity = undefined;
        h.pendingPermission = undefined;
        h.pendingQuestion = undefined;
        push({ name: "exit", ...(error ? { error: error.message } : {}) });
        for (const off of h.unsubs) off();
        h.unsubs = [];
        // when a hub is attached it has the exit now; otherwise keep the record until the next hello
        if (this.#hub) this.#units.delete(spec.unitId);
      }),
    );
    return h;
  }

  #forget(unitId: string): void {
    const h = this.#units.get(unitId);
    if (!h) return;
    for (const off of h.unsubs) off();
    this.#units.delete(unitId);
  }

  #emit(h: Hosted, ev: RuntimeEvent): void {
    if (this.#send(this.#hub, { type: "event", unitId: h.spec.unitId, event: ev })) return;
    const limit = this.#opts.bufferLimit ?? 5000;
    h.buffered.push(ev);
    if (h.buffered.length > limit) {
      // keep the newest; transcripts are also in the session file, results matter most
      h.buffered.splice(0, h.buffered.length - limit);
      h.dropped += 1;
    }
  }

  #snapshot(h: Hosted): HostedUnit {
    const status: UnitStatus = h.exited ? "offline" : h.rt.status;
    return {
      spec: h.spec,
      status,
      sessionId: h.rt.sessionId ?? h.spec.sessionId,
      inFlight: h.exited ? false : h.rt.inFlight,
      ...(h.activity ? { activity: h.activity } : {}),
      ...(h.pendingPermission ? { pendingPermission: h.pendingPermission } : {}),
      ...(h.pendingQuestion ? { pendingQuestion: h.pendingQuestion } : {}),
      buffered: h.buffered,
      dropped: h.dropped,
    };
  }

  // --------------------------------------------------------------------- bridge (host → hub)

  #bridge(unitId: string, kind: "tool" | "nudge", name: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.#closing) return Promise.reject(new Error("unit host shutting down"));
    const id = nanoid(10);
    return new Promise<unknown>((resolve, reject) => {
      const timeoutMs = this.#opts.bridgeTimeoutMs ?? 60_000;
      const timer = setTimeout(() => {
        if (!this.#bridges.has(id)) return;
        this.#bridges.delete(id);
        reject(new Error(`fleet unavailable: no hub answered within ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      this.#bridges.set(id, { id, unitId, kind, name, args, resolve, reject, timer });
      // no hub right now: the call is re-sent when one attaches (see hello)
      this.#send(this.#hub, { type: "bridge", id, unitId, kind, name, args });
    });
  }
}
