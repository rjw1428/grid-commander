/**
 * Runtime implementation that proxies to a unit hosted in the unit host process. The hub treats it
 * exactly like UnitRuntime; the only extra is `replay()`, which re-emits the host's snapshot and
 * buffered events after a re-attach so UnitService can rebuild its projection.
 */
import { nanoid } from "nanoid";
import type { OrderSource, PermissionMode, UnitStatus } from "@gridcommander/shared";
import { Emitter } from "../runtime/emitter.js";
import type { PermissionAnswer, Runtime, RuntimeEvents, TurnResult } from "../runtime/Runtime.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { HostClient } from "./HostClient.js";
import type { HostedUnit, RuntimeEvent, UnitSpec } from "./protocol.js";

export class RemoteRuntime implements Runtime {
  readonly unitId: string;
  #client: HostClient;
  #spec: UnitSpec;
  #log: RuntimeLogger;
  #events: Emitter<RuntimeEvents>;
  #status: UnitStatus = "offline";
  #sessionId: string | undefined;
  #inFlight = false;
  #pendingTurn: { resolve: (r: TurnResult) => void } | null = null;
  #attached: HostedUnit | null;
  #offEvent: (() => void) | null = null;
  #offDisconnect: (() => void) | null = null;
  #bound = false;

  #ensure: (() => Promise<unknown>) | undefined;

  /**
   * @param ensure called before start(): brings the host connection up (and adopts whatever it still
   *   runs) when the hub is not attached, so a start never fails just because the host was idle.
   */
  constructor(client: HostClient, spec: UnitSpec, log: RuntimeLogger, attached?: HostedUnit, ensure?: () => Promise<unknown>) {
    this.unitId = spec.unitId;
    this.#client = client;
    this.#spec = spec;
    this.#log = log;
    this.#ensure = ensure;
    this.#sessionId = spec.sessionId;
    this.#attached = attached ?? null;
    this.#events = new Emitter<RuntimeEvents>((err, ev) => log.error({ err, ev, unitId: spec.unitId }, "runtime listener threw"));
    if (attached) {
      this.#status = attached.status;
      this.#sessionId = attached.sessionId ?? spec.sessionId;
      this.#inFlight = attached.inFlight;
      this.#bind();
    }
  }

  get status(): UnitStatus {
    return this.#status;
  }
  get sessionId(): string | undefined {
    return this.#sessionId;
  }
  get inFlight(): boolean {
    return this.#inFlight;
  }
  get spec(): UnitSpec {
    return this.#spec;
  }

  on<K extends keyof RuntimeEvents>(event: K, listener: RuntimeEvents[K]): () => void {
    return this.#events.on(event, listener);
  }

  /**
   * After re-attaching: emit everything the hub missed (buffered events, oldest first), then the
   * host's current state so status/activity/prompts are exact. Call once listeners are wired.
   */
  replay(): void {
    const a = this.#attached;
    if (!a) return;
    this.#attached = null;
    if (a.dropped) this.#events.emit("notice", `${a.dropped} transcript events were dropped while the server was down.`, "info");
    for (const ev of a.buffered) this.#apply(ev, true);
    if (a.status === "offline") return; // exit was in the buffer; nothing else to restore
    this.#status = a.status;
    this.#events.emit("status", a.status, Date.now());
    this.#events.emit("activity", a.activity);
    if (a.pendingPermission) this.#events.emit("permission", a.pendingPermission);
    if (a.pendingQuestion) this.#events.emit("question", a.pendingQuestion);
    this.#inFlight = a.inFlight;
  }

  async start(): Promise<void> {
    if (this.#bound) throw new Error(`unit ${this.unitId} already started`);
    if (!this.#client.connected) {
      if (this.#ensure) await this.#ensure();
      else await this.#client.ensureConnected();
    }
    this.#bind();
    try {
      const v = (await this.#client.request({ type: "start", id: nanoid(10), spec: this.#spec })) as { status?: UnitStatus; sessionId?: string } | undefined;
      if (v?.sessionId) this.#sessionId = v.sessionId;
    } catch (err) {
      this.#unbind();
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (!this.#bound) return;
    try {
      await this.#client.request({ type: "stop", id: nanoid(10), unitId: this.unitId });
    } catch (err) {
      this.#log.warn({ err, unitId: this.unitId }, "stop via host failed");
    }
    this.#finishExit(undefined);
  }

  async submit(text: string, source: OrderSource): Promise<TurnResult> {
    if (!this.#bound) throw new Error(`unit ${this.unitId} is offline`);
    if (this.#inFlight) throw new Error(`unit ${this.unitId} already has a turn in flight`);
    this.#inFlight = true;
    const result = new Promise<TurnResult>((resolve) => {
      this.#pendingTurn = { resolve };
    });
    try {
      await this.#client.request({ type: "submit", id: nanoid(10), unitId: this.unitId, text, source });
    } catch (err) {
      this.#inFlight = false;
      this.#pendingTurn = null;
      throw err;
    }
    return result;
  }

  async interrupt(): Promise<void> {
    if (!this.#bound || !this.#inFlight) return;
    await this.#client.request({ type: "interrupt", id: nanoid(10), unitId: this.unitId }, 30_000);
  }

  answerPermission(answer: PermissionAnswer): boolean {
    if (!this.#bound) return false;
    // the host validates there is a pending prompt; the reply is informational
    void this.#client.request({ type: "answerPermission", id: nanoid(10), unitId: this.unitId, answer }).catch((err) => this.#log.warn({ err, unitId: this.unitId }, "answerPermission via host failed"));
    return true;
  }

  answerQuestion(answers: Record<string, string>): boolean {
    if (!this.#bound) return false;
    void this.#client.request({ type: "answerQuestion", id: nanoid(10), unitId: this.unitId, answers }).catch((err) => this.#log.warn({ err, unitId: this.unitId }, "answerQuestion via host failed"));
    return true;
  }

  async setModel(model: string): Promise<void> {
    this.#spec = { ...this.#spec, model };
    if (this.#bound) await this.#client.request({ type: "setModel", id: nanoid(10), unitId: this.unitId, model });
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.#spec = { ...this.#spec, permissionMode: mode };
    if (this.#bound) await this.#client.request({ type: "setPermissionMode", id: nanoid(10), unitId: this.unitId, mode });
  }

  async contextUsage(): Promise<number | undefined> {
    if (!this.#bound) return undefined;
    const v = await this.#client.request({ type: "contextUsage", id: nanoid(10), unitId: this.unitId });
    return typeof v === "number" ? v : undefined;
  }

  // --------------------------------------------------------------------- events

  #bind(): void {
    if (this.#bound) return;
    this.#bound = true;
    this.#offEvent = this.#client.on("event", (unitId, ev) => {
      if (unitId === this.unitId) this.#apply(ev, false);
    });
    this.#offDisconnect = this.#client.on("disconnect", (reason) => this.#finishExit(new Error(`unit host disconnected: ${reason}`)));
  }

  #unbind(): void {
    this.#bound = false;
    this.#offEvent?.();
    this.#offDisconnect?.();
    this.#offEvent = null;
    this.#offDisconnect = null;
  }

  #apply(ev: RuntimeEvent, replaying: boolean): void {
    switch (ev.name) {
      case "status":
        this.#status = ev.status;
        this.#events.emit("status", ev.status, ev.at);
        return;
      case "activity":
        this.#events.emit("activity", ev.activity);
        return;
      case "transcript":
        this.#events.emit("transcript", ev.entries);
        return;
      case "toolResult":
        this.#events.emit("toolResult", { toolUseId: ev.toolUseId, ok: ev.ok, at: ev.at });
        return;
      case "permission":
        this.#events.emit("permission", ev.request);
        return;
      case "question":
        this.#events.emit("question", ev.question);
        return;
      case "init":
        this.#sessionId = ev.info.sessionId;
        this.#spec = { ...this.#spec, sessionId: ev.info.sessionId };
        this.#events.emit("init", ev.info);
        return;
      case "result": {
        this.#inFlight = false;
        const turn = this.#pendingTurn;
        this.#pendingTurn = null;
        this.#events.emit("result", ev.result);
        turn?.resolve(ev.result);
        return;
      }
      case "stopCapture":
        this.#events.emit("stopCapture", ev.text);
        return;
      case "notice":
        this.#events.emit("notice", ev.text, ev.severity);
        return;
      case "exit":
        if (replaying) this.#status = "offline";
        this.#finishExit(ev.error ? new Error(ev.error) : undefined);
        return;
    }
  }

  #finishExit(err: Error | undefined): void {
    if (!this.#bound) return;
    this.#unbind();
    const turn = this.#pendingTurn;
    this.#pendingTurn = null;
    this.#inFlight = false;
    if (turn) {
      const text = err ? `Session lost: ${err.message}` : "Session ended";
      this.#status = err ? "error" : "offline";
      turn.resolve({ ok: false, text, errors: [text], at: Date.now() });
    } else if (err && (this.#status === "working" || this.#status === "waiting")) {
      this.#status = "error";
    } else {
      this.#status = "offline";
    }
    this.#events.emit("exit", err);
  }
}
