import type { Alert, AlertKind, Settings, Unit } from "@hexcommand/shared";
import { nanoid } from "nanoid";
import type { Bus } from "../bus.js";
import { notFound } from "../errors.js";
import { Emitter } from "../runtime/emitter.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { Stores } from "../store/stores.js";
import type { FleetService } from "../fleet/FleetService.js";
import type { UnitService } from "../fleet/UnitService.js";

export interface AlertEngineDeps {
  stores: Stores;
  bus: Bus;
  fleet: FleetService;
  units: UnitService;
  settings: () => Settings;
  log: RuntimeLogger;
  watchdogMs?: number;
}

interface AlertEvents {
  raised: (alert: Alert, isNew: boolean) => void;
}

const firstLine = (s: string | undefined, max = 140) => {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
};

/** Derives operator alerts from unit events; collapses by (kind, unitId); idle watchdog. */
export class AlertEngine extends Emitter<AlertEvents> {
  readonly open = new Map<string, Alert>();
  #deps: AlertEngineDeps;
  #timer: NodeJS.Timeout | null = null;
  #unsubs: (() => void)[] = [];

  constructor(deps: AlertEngineDeps) {
    super((err, ev) => deps.log.error({ err, ev }, "AlertEngine listener threw"));
    this.#deps = deps;
    for (const a of deps.stores.alerts.open()) this.open.set(a.id, a);
  }

  start(): void {
    const { units } = this.#deps;
    this.#unsubs.push(
      units.on("status", (unit, prev) => {
        if (unit.status === "working" && prev !== "working") this.autoDismissForUnit(unit.id);
        if (unit.status === "waiting") {
          const body = unit.pendingPermission
            ? unit.pendingPermission.summary
            : unit.pendingQuestion
              ? firstLine(unit.pendingQuestion.questions[0]?.question)
              : "needs input";
          this.raise({ kind: "waiting", unitId: unit.id, title: `${unit.name} needs approval`, body });
        }
        if (unit.status === "offline" && prev !== "offline") this.dismissWhere((a) => a.unitId === unit.id && a.kind === "waiting");
      }),
      units.on("turnFinished", (unit, result) => {
        if (result.interrupted && result.ok) return;
        if (result.ok) {
          this.raise({ kind: "done", unitId: unit.id, title: `${unit.name} finished`, body: firstLine(result.text) || "Turn complete" });
        } else {
          this.raise({
            kind: "error",
            unitId: unit.id,
            title: `${unit.name} errored`,
            body: firstLine(result.errors?.[0] ?? result.text) || "Turn failed",
          });
        }
      }),
      units.on("notice", (unit, text, severity) => {
        this.raise({ kind: "info", unitId: unit.id, title: severity === "error" ? `${unit.name}: error` : unit.name, body: firstLine(text, 200) });
      }),
    );
    this.#timer = setInterval(() => this.#watchdog(), this.#deps.watchdogMs ?? 15_000);
    this.#timer.unref?.();
  }

  stop(): void {
    for (const off of this.#unsubs) off();
    this.#unsubs = [];
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }

  list(): Alert[] {
    return [...this.open.values()].sort((a, b) => a.createdAt - b.createdAt);
  }

  raise(input: { kind: AlertKind; unitId?: string; title: string; body: string; payload?: unknown }): Alert {
    const existing = [...this.open.values()].find((a) => a.kind === input.kind && a.unitId === input.unitId && (input.unitId || input.kind !== "info"));
    const alert: Alert = {
      id: existing?.id ?? nanoid(10),
      kind: input.kind,
      ...(input.unitId ? { unitId: input.unitId } : {}),
      title: input.title,
      body: input.body,
      createdAt: Date.now(),
      ...(input.payload !== undefined ? { payload: input.payload } : {}),
    };
    this.open.set(alert.id, alert);
    this.#deps.stores.alerts.upsert(alert);
    this.#deps.bus.publish({ type: "alert.upsert", alert });
    this.emit("raised", alert, !existing);
    return alert;
  }

  dismiss(id: string): void {
    const a = this.open.get(id);
    if (!a) throw notFound("alert", id);
    this.#dismiss(a);
  }

  dismissAll(): number {
    const all = [...this.open.values()];
    for (const a of all) this.#dismiss(a);
    return all.length;
  }

  dismissWhere(pred: (a: Alert) => boolean): void {
    for (const a of [...this.open.values()]) if (pred(a)) this.#dismiss(a);
  }

  /** waiting/error/done/idle alerts for a unit go away when it starts working again. */
  autoDismissForUnit(unitId: string): void {
    this.dismissWhere((a) => a.unitId === unitId && (a.kind === "waiting" || a.kind === "error" || a.kind === "done" || a.kind === "idle"));
  }

  #dismiss(a: Alert): void {
    this.open.delete(a.id);
    this.#deps.stores.alerts.upsert({ ...a, dismissedAt: Date.now() });
    this.#deps.bus.publish({ type: "alert.remove", id: a.id });
  }

  #watchdog(): void {
    const idleMs = this.#deps.settings()["alerts.idleMs"];
    const now = Date.now();
    for (const unit of this.#deps.fleet.units.values()) {
      if (unit.status !== "idle" || unit.queueLength > 0) continue;
      const idleFor = now - unit.statusSince;
      if (idleFor < idleMs) continue;
      const minutes = Math.floor(idleFor / 60_000);
      const existing = [...this.open.values()].find((a) => a.kind === "idle" && a.unitId === unit.id);
      const body = `Idle for ${minutes} min${unit.task ? ` · ${unit.task}` : ""}`;
      if (existing && existing.body === body) continue;
      this.raise({ kind: "idle", unitId: unit.id, title: `${unit.name} is idle`, body });
    }
    this.#deps.stores.alerts.pruneDismissed(7 * 24 * 3600 * 1000);
  }

  /** For tests: run one watchdog tick now. */
  tick(): void {
    this.#watchdog();
  }

  unitFor(a: Alert): Unit | undefined {
    return a.unitId ? this.#deps.fleet.units.get(a.unitId) : undefined;
  }
}
