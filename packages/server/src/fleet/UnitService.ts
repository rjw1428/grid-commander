import {
  getUnitType,
  type OrderSource,
  type PermissionAnswerBody,
  type PermissionMode,
  type Project,
  type TranscriptEntry,
  type Unit,
  type UnitStatus,
  type UnitTypeDef,
} from "@hexcommand/shared";
import type { Bus } from "../bus.js";
import { badRequest, conflict } from "../errors.js";
import { Emitter } from "../runtime/emitter.js";
import type { Runtime, TurnResult } from "../runtime/Runtime.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { Stores } from "../store/stores.js";
import type { FleetService } from "./FleetService.js";

export interface RuntimeFactoryCtx {
  unit: Unit;
  type: UnitTypeDef;
  project: Project;
  cwd: string;
  /** Live view of the unit (name/task/team change over the session). */
  getUnit: () => Unit;
  comms?: import("../comms/CommsBroker.js").CommsBroker;
}
export type RuntimeFactory = (ctx: RuntimeFactoryCtx) => Runtime;

export interface UnitServiceDeps {
  fleet: FleetService;
  stores: Stores;
  bus: Bus;
  factory: RuntimeFactory;
  maxUnits: number;
  doneAutoAckMs: number;
  log: RuntimeLogger;
  /** Transcript WS batching window; 0 publishes synchronously (tests). */
  transcriptBatchMs?: number;
  /** Resolved lazily because the broker is constructed after the unit service. */
  getComms?: () => import("../comms/CommsBroker.js").CommsBroker | undefined;
}

interface UnitServiceEvents {
  status: (unit: Unit, prev: UnitStatus) => void;
  turnFinished: (unit: Unit, result: TurnResult) => void;
  notice: (unit: Unit, text: string, severity: "info" | "error") => void;
  started: (unit: Unit) => void;
  stopped: (unit: Unit) => void;
}

/** Owns one Runtime per running unit and projects runtime events onto Unit fields + the bus. */
export class UnitService extends Emitter<UnitServiceEvents> {
  readonly runtimes = new Map<string, Runtime>();
  #deps: UnitServiceDeps;
  #unsubs = new Map<string, (() => void)[]>();
  #batches = new Map<string, { entries: TranscriptEntry[]; timer: NodeJS.Timeout | null }>();
  #autoAck = new Map<string, NodeJS.Timeout>();

  constructor(deps: UnitServiceDeps) {
    super((err, ev) => deps.log.error({ err, ev }, "UnitService listener threw"));
    this.#deps = deps;
  }

  get runningCount(): number {
    return this.runtimes.size;
  }

  runtime(id: string): Runtime | undefined {
    return this.runtimes.get(id);
  }

  // --------------------------------------------------------------------- lifecycle

  async start(id: string): Promise<Unit> {
    const { fleet, factory, maxUnits } = this.#deps;
    const unit = fleet.getUnit(id);
    if (this.runtimes.has(id)) throw conflict("already_running", `unit "${unit.name}" is already running`);
    if (this.runtimes.size >= maxUnits) throw conflict("max_units", `FLEET_MAX_UNITS (${maxUnits}) running units reached`);
    const type = getUnitType(unit.type);
    const project = fleet.getProject(unit.projectId);
    const rt = factory({ unit, type, project, cwd: fleet.projectCwd(project), getUnit: () => fleet.getUnit(id), comms: this.#deps.getComms?.() });
    this.runtimes.set(id, rt);
    this.#wire(id, rt);
    try {
      await rt.start();
    } catch (err) {
      this.#unwire(id);
      this.runtimes.delete(id);
      const u = fleet.updateUnit(id, { status: "offline", statusSince: Date.now(), activity: undefined });
      this.emit("notice", u, `Failed to start: ${err instanceof Error ? err.message : String(err)}`, "error");
      throw badRequest(`unit "${unit.name}" failed to start: ${err instanceof Error ? err.message : String(err)}`, "start_failed");
    }
    const started = fleet.getUnit(id);
    this.emit("started", started);
    return started;
  }

  async stop(id: string): Promise<Unit> {
    const rt = this.runtimes.get(id);
    const unit = this.#deps.fleet.getUnit(id);
    if (!rt) return unit;
    await rt.stop();
    // exit handler cleans up; make sure even if the runtime never emitted exit
    this.#onExit(id);
    return this.#deps.fleet.getUnit(id);
  }

  async interrupt(id: string): Promise<void> {
    const rt = this.runtimes.get(id);
    this.#deps.fleet.getUnit(id);
    if (!rt) return;
    await rt.interrupt();
  }

  ack(id: string): Unit {
    const unit = this.#deps.fleet.getUnit(id);
    if (unit.status !== "done" && unit.status !== "error") return unit;
    this.#clearAutoAck(id);
    const next = this.#deps.fleet.updateUnit(id, { status: "idle", statusSince: Date.now() });
    this.emit("status", next, unit.status);
    return next;
  }

  async submit(id: string, text: string, source: OrderSource): Promise<TurnResult> {
    const rt = this.runtimes.get(id);
    const unit = this.#deps.fleet.getUnit(id);
    if (!rt) throw conflict("offline", `unit "${unit.name}" is offline`);
    if (rt.inFlight) throw conflict("busy", `unit "${unit.name}" already has a turn in flight`);
    if (unit.status === "done" || unit.status === "error") this.#clearAutoAck(id);
    if (source === "operator" || source === "broadcast" || source === "queue") {
      if (unit.missionDone) this.#deps.fleet.updateUnit(id, { missionDone: undefined });
    }
    return rt.submit(text, source);
  }

  canAcceptTurn(id: string): boolean {
    const rt = this.runtimes.get(id);
    const unit = this.#deps.fleet.units.get(id);
    if (!rt || !unit) return false;
    return !rt.inFlight && (unit.status === "idle" || unit.status === "done" || unit.status === "error");
  }

  answerPermission(id: string, body: PermissionAnswerBody): Unit {
    const rt = this.runtimes.get(id);
    const unit = this.#deps.fleet.getUnit(id);
    if (!rt || !rt.answerPermission(body)) throw conflict("nothing_pending", `unit "${unit.name}" has no pending permission request`);
    return this.#deps.fleet.getUnit(id);
  }

  answerQuestion(id: string, answers: Record<string, string>): Unit {
    const rt = this.runtimes.get(id);
    const unit = this.#deps.fleet.getUnit(id);
    if (!rt || !rt.answerQuestion(answers)) throw conflict("nothing_pending", `unit "${unit.name}" has no pending question`);
    return this.#deps.fleet.getUnit(id);
  }

  async setModel(id: string, model: string): Promise<void> {
    await this.runtimes.get(id)?.setModel(model);
  }

  async setPermissionMode(id: string, mode: PermissionMode): Promise<void> {
    await this.runtimes.get(id)?.setPermissionMode(mode);
  }

  async contextUsage(id: string): Promise<number | undefined> {
    return this.runtimes.get(id)?.contextUsage();
  }

  transcript(id: string, opts: { before?: number; limit: number }): TranscriptEntry[] {
    this.#deps.fleet.getUnit(id);
    return this.#deps.stores.transcript.list(id, opts);
  }

  /** Stop (if running) and remove the unit. Transcript rows are kept; orders are dropped. */
  async remove(id: string): Promise<void> {
    await this.stop(id);
    this.#deps.stores.orders.removeForUnit(id);
    this.#deps.fleet.deleteUnit(id);
  }

  async shutdown(): Promise<void> {
    await Promise.allSettled([...this.runtimes.keys()].map((id) => this.stop(id)));
    for (const b of this.#batches.values()) if (b.timer) clearTimeout(b.timer);
    for (const t of this.#autoAck.values()) clearTimeout(t);
  }

  // --------------------------------------------------------------------- runtime → unit projection

  #wire(id: string, rt: Runtime): void {
    const { fleet, bus, stores } = this.#deps;
    const unsubs: (() => void)[] = [];

    unsubs.push(
      rt.on("status", (status, at) => {
        const prev = fleet.units.get(id);
        if (!prev) return;
        const patch: Partial<Unit> = { status, statusSince: at };
        if (status === "working") {
          patch.pendingPermission = undefined;
          patch.pendingQuestion = undefined;
        }
        if (status === "offline") {
          patch.activity = undefined;
          patch.pendingPermission = undefined;
          patch.pendingQuestion = undefined;
        }
        const next = fleet.updateUnit(id, patch);
        if (status === "done") this.#scheduleAutoAck(id);
        else this.#clearAutoAck(id);
        bus.publish({ type: "unit.upsert", unit: next });
        this.emit("status", next, prev.status);
      }),
      rt.on("activity", (activity) => {
        const next = fleet.updateUnit(id, { activity });
        bus.publish({ type: "unit.upsert", unit: next });
      }),
      rt.on("transcript", (entries) => {
        stores.transcript.append(id, entries);
        this.#queueTranscript(id, entries);
      }),
      rt.on("toolResult", ({ toolUseId, ok, at }) => {
        const entry = stores.transcript.updateTool(id, toolUseId, { ok });
        const durationMs = entry && entry.kind === "tool" ? at - entry.at : undefined;
        if (entry && durationMs !== undefined) stores.transcript.updateTool(id, toolUseId, { ok, durationMs });
        bus.publish({ type: "unit.transcriptUpdate", unitId: id, toolUseId, ok, ...(durationMs !== undefined ? { durationMs } : {}) });
      }),
      rt.on("permission", (request) => {
        const next = fleet.updateUnit(id, { pendingPermission: request ?? undefined });
        bus.publish({ type: "unit.permission", unitId: id, request });
        bus.publish({ type: "unit.upsert", unit: next });
      }),
      rt.on("question", (question) => {
        const next = fleet.updateUnit(id, { pendingQuestion: question ?? undefined });
        bus.publish({ type: "unit.question", unitId: id, question });
        bus.publish({ type: "unit.upsert", unit: next });
      }),
      rt.on("init", (info) => {
        const next = fleet.updateUnit(id, { sessionId: info.sessionId });
        bus.publish({ type: "unit.upsert", unit: next });
      }),
      rt.on("result", (result) => {
        const next = fleet.updateUnit(id, {
          lastResult: {
            at: result.at,
            text: result.text.slice(0, 20_000),
            ok: result.ok,
            ...(result.costUsd !== undefined ? { costUsd: result.costUsd } : {}),
            ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
          },
        });
        bus.publish({ type: "unit.upsert", unit: next });
        this.emit("turnFinished", next, result);
      }),
      rt.on("notice", (text, severity) => {
        const u = fleet.units.get(id);
        if (u) this.emit("notice", u, text, severity);
      }),
      rt.on("exit", (err) => {
        const u = fleet.units.get(id);
        if (err && u) this.emit("notice", u, `Session ended unexpectedly: ${err.message}`, "error");
        this.#onExit(id);
      }),
    );
    this.#unsubs.set(id, unsubs);
  }

  #unwire(id: string): void {
    for (const off of this.#unsubs.get(id) ?? []) off();
    this.#unsubs.delete(id);
  }

  #onExit(id: string): void {
    const rt = this.runtimes.get(id);
    if (!rt) return;
    this.#unwire(id);
    this.runtimes.delete(id);
    this.#clearAutoAck(id);
    this.#flushTranscript(id);
    const u = this.#deps.fleet.units.get(id);
    if (!u) return;
    const prev = u.status;
    const status: UnitStatus = rt.status === "error" ? "error" : "offline";
    const next = this.#deps.fleet.updateUnit(id, {
      status,
      statusSince: prev === status ? u.statusSince : Date.now(),
      activity: undefined,
      pendingPermission: undefined,
      pendingQuestion: undefined,
    });
    this.#deps.bus.publish({ type: "unit.upsert", unit: next });
    if (prev !== status) this.emit("status", next, prev);
    this.emit("stopped", next);
  }

  #queueTranscript(id: string, entries: TranscriptEntry[]): void {
    const ms = this.#deps.transcriptBatchMs ?? 100;
    if (ms <= 0) {
      this.#deps.bus.publish({ type: "unit.transcript", unitId: id, entries });
      return;
    }
    let b = this.#batches.get(id);
    if (!b) {
      b = { entries: [], timer: null };
      this.#batches.set(id, b);
    }
    b.entries.push(...entries);
    if (!b.timer) b.timer = setTimeout(() => this.#flushTranscript(id), ms);
  }

  #flushTranscript(id: string): void {
    const b = this.#batches.get(id);
    if (!b) return;
    if (b.timer) clearTimeout(b.timer);
    this.#batches.delete(id);
    if (b.entries.length) this.#deps.bus.publish({ type: "unit.transcript", unitId: id, entries: b.entries });
  }

  #scheduleAutoAck(id: string): void {
    this.#clearAutoAck(id);
    const ms = this.#deps.doneAutoAckMs;
    if (!ms || ms <= 0) return;
    this.#autoAck.set(
      id,
      setTimeout(() => {
        this.#autoAck.delete(id);
        const u = this.#deps.fleet.units.get(id);
        if (u?.status === "done") this.ack(id);
      }, ms),
    );
  }

  #clearAutoAck(id: string): void {
    const t = this.#autoAck.get(id);
    if (t) clearTimeout(t);
    this.#autoAck.delete(id);
  }
}
