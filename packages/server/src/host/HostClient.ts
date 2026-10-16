/**
 * Hub-side connection to the unit host. Connects to the Unix socket, launching a detached host
 * process first when none is listening. Request/reply plus per-unit event fan-out. Reconnection is
 * driven by the hub (it needs to re-attach units), not here.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, writeFileSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { dirname } from "node:path";
import { nanoid } from "nanoid";
import { Emitter } from "../runtime/emitter.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import {
  encodeFrame,
  FrameParser,
  HelloReplySchema,
  HOST_PROTOCOL_VERSION,
  HostMessageSchema,
  type HelloReply,
  type HubRequest,
  type RuntimeEvent,
} from "./protocol.js";

export interface HostSpawnOptions {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Host stdout/stderr go here (the process is detached). */
  logFile: string;
  pidFile?: string;
}

/** Answers a bridge call from a session: fleet tool (`kind: "tool"`) or inbox nudge (`kind: "nudge"`). */
export type BridgeHandler = (unitId: string, kind: "tool" | "nudge", name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface HostClientOptions {
  socketPath: string;
  log: RuntimeLogger;
  hubVersion: string;
  bridge: BridgeHandler;
  /** How to launch a host when none is listening. Without it, connect() fails when the host is down. */
  spawn?: HostSpawnOptions;
  /** Total time connect() may spend (including the spawn). */
  connectTimeoutMs?: number;
  /** Ordinary request timeout. */
  requestTimeoutMs?: number;
}

interface ClientEvents {
  event: (unitId: string, ev: RuntimeEvent) => void;
  /** The host is shutting down and will stop these units; their exits are not the units' doing. */
  closing: (unitIds: string[]) => void;
  disconnect: (reason: string) => void;
}

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout | null };

export class HostClient extends Emitter<ClientEvents> {
  #opts: HostClientOptions;
  #log: RuntimeLogger;
  #sock: Socket | null = null;
  #pending = new Map<string, Pending>();
  #hello: HelloReply | null = null;
  #spawnedPid: number | undefined;

  constructor(opts: HostClientOptions) {
    super((err, ev) => opts.log.error({ err, ev }, "HostClient listener threw"));
    this.#opts = opts;
    this.#log = opts.log;
  }

  get connected(): boolean {
    return this.#sock !== null && !this.#sock.destroyed;
  }
  get hostInfo(): HelloReply | null {
    return this.#hello;
  }

  #connecting: Promise<HelloReply> | null = null;

  /** connect() unless already connected; concurrent callers share one attempt. */
  ensureConnected(): Promise<HelloReply | null> {
    if (this.connected) return Promise.resolve(this.#hello);
    if (!this.#connecting) {
      this.#connecting = this.connect().finally(() => {
        this.#connecting = null;
      });
    }
    return this.#connecting;
  }

  /** Connect (spawning the host if needed) and perform the hello handshake. */
  async connect(): Promise<HelloReply> {
    if (this.connected) throw new Error("already connected to the unit host");
    if (Buffer.byteLength(this.#opts.socketPath) > 100) {
      throw new Error(`unit host socket path is too long for this OS (${Buffer.byteLength(this.#opts.socketPath)} bytes): ${this.#opts.socketPath}; set FLEET_HOST_SOCKET to a shorter path`);
    }
    const deadline = Date.now() + (this.#opts.connectTimeoutMs ?? 10_000);
    let spawned = false;
    let lastErr: Error | undefined;
    while (Date.now() < deadline) {
      try {
        await this.#dial();
        break;
      } catch (err) {
        lastErr = err instanceof Error ? err : new Error(String(err));
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ECONNREFUSED") throw err;
        if (!this.#opts.spawn) throw new Error(`unit host is not running (${this.#opts.socketPath})`);
        if (!spawned) {
          this.#spawnHost();
          spawned = true;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!this.connected) throw new Error(`could not reach the unit host: ${lastErr?.message ?? "timeout"}`);
    const raw = await this.request({ type: "hello", id: nanoid(10), protocol: HOST_PROTOCOL_VERSION, hubVersion: this.#opts.hubVersion });
    const hello = HelloReplySchema.parse(raw);
    this.#hello = hello;
    this.#log.info({ pid: hello.pid, hostVersion: hello.hostVersion, units: hello.units.length, spawned }, "attached to unit host");
    return hello;
  }

  /** Drop the connection without stopping anything on the host. Bound runtimes see it as a disconnect. */
  disconnect(): void {
    const s = this.#sock;
    if (!s) return;
    this.#sock = null;
    this.#hello = null;
    s.destroy();
    this.#failPending("hub detached");
    this.emit("disconnect", "hub detached");
  }

  async request(msg: HubRequest, timeoutMs = this.#opts.requestTimeoutMs ?? 30_000): Promise<unknown> {
    const sock = this.#sock;
    if (!sock || sock.destroyed) throw new Error("unit host is not connected");
    return new Promise<unknown>((resolve, reject) => {
      const timer =
        timeoutMs > 0
          ? setTimeout(() => {
              this.#pending.delete(msg.id);
              reject(new Error(`unit host did not answer ${msg.type} within ${timeoutMs}ms`));
            }, timeoutMs)
          : null;
      this.#pending.set(msg.id, { resolve, reject, timer });
      sock.write(encodeFrame(msg));
    });
  }

  /** Fire-and-forget frame (bridge results). */
  send(msg: HubRequest): void {
    const sock = this.#sock;
    if (!sock || sock.destroyed) return;
    sock.write(encodeFrame(msg));
  }

  // --------------------------------------------------------------------- internals

  #dial(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const sock = connect(this.#opts.socketPath);
      sock.setEncoding("utf8");
      const onError = (err: Error) => {
        sock.destroy();
        reject(err);
      };
      sock.once("error", onError);
      sock.once("connect", () => {
        sock.off("error", onError);
        this.#sock = sock;
        this.#wire(sock);
        resolve();
      });
    });
  }

  #wire(sock: Socket): void {
    const parser = new FrameParser();
    sock.on("data", (chunk: string) => {
      for (const raw of parser.push(chunk, (line) => this.#log.warn({ line: line.slice(0, 200) }, "bad frame from host"))) {
        const parsed = HostMessageSchema.safeParse(raw);
        if (!parsed.success) {
          this.#log.warn({ issue: parsed.error.issues[0]?.message, path: parsed.error.issues[0]?.path.join(".") }, "invalid message from host");
          continue;
        }
        const m = parsed.data;
        if (m.type === "reply") {
          const p = this.#pending.get(m.id);
          if (!p) continue;
          this.#pending.delete(m.id);
          if (p.timer) clearTimeout(p.timer);
          if (m.ok) p.resolve(m.value);
          else p.reject(new Error(m.error ?? "host request failed"));
        } else if (m.type === "event") {
          this.emit("event", m.unitId, m.event);
        } else if (m.type === "closing") {
          this.#log.warn({ units: m.units.length }, "unit host is shutting down");
          this.emit("closing", m.units);
        } else {
          void this.#opts
            .bridge(m.unitId, m.kind, m.name, m.args)
            .then((value) => this.send({ type: "bridgeResult", id: m.id, ok: true, value }))
            .catch((err: unknown) => this.send({ type: "bridgeResult", id: m.id, ok: false, error: err instanceof Error ? err.message : String(err) }));
        }
      }
    });
    const onGone = (reason: string) => {
      if (this.#sock !== sock) return;
      this.#sock = null;
      this.#hello = null;
      this.#failPending(reason);
      this.#log.warn({ reason }, "unit host connection lost");
      this.emit("disconnect", reason);
    };
    sock.on("close", () => onGone("socket closed"));
    sock.on("error", (err) => onGone(err.message));
  }

  #failPending(reason: string): void {
    for (const p of this.#pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error(`unit host disconnected: ${reason}`));
    }
    this.#pending.clear();
  }

  #spawnHost(): void {
    const s = this.#opts.spawn!;
    mkdirSync(dirname(s.logFile), { recursive: true });
    const fd = openSync(s.logFile, "a");
    try {
      const child = spawn(s.command, s.args, {
        detached: true,
        stdio: ["ignore", fd, fd],
        env: s.env ?? process.env,
        cwd: s.cwd,
      });
      child.on("error", (err) => this.#log.error({ err }, "failed to spawn unit host"));
      child.unref();
      this.#spawnedPid = child.pid;
      if (s.pidFile && child.pid) writeFileSync(s.pidFile, `${child.pid}\n`);
      this.#log.info({ pid: child.pid, logFile: s.logFile }, "launched unit host");
    } finally {
      closeSync(fd);
    }
  }

  get spawnedPid(): number | undefined {
    return this.#spawnedPid;
  }
}
