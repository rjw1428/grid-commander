import type { Order, OrderSource } from "@hexcommand/shared";
import { nanoid } from "nanoid";
import type { Bus } from "../bus.js";
import { notFound } from "../errors.js";
import { Emitter } from "../runtime/emitter.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { Stores } from "../store/stores.js";
import type { FleetService } from "./FleetService.js";
import type { UnitService } from "./UnitService.js";

export interface OrderServiceDeps {
  stores: Stores;
  fleet: FleetService;
  units: UnitService;
  bus: Bus;
  log: RuntimeLogger;
  /** Start an offline unit when it receives an order. */
  autoStartOnOrder?: boolean;
}

interface OrderEvents {
  /** The unit reached a turn boundary with nothing queued (CommsBroker delivers the inbox here). */
  queueEmpty: (unitId: string) => void;
  submitted: (order: Order) => void;
}

/** Per-unit FIFO of orders. Drains whenever the unit can accept a turn. */
export class OrderService extends Emitter<OrderEvents> {
  #deps: OrderServiceDeps;
  #draining = new Set<string>();
  #preempt: ((unitId: string) => boolean) | null = null;

  /** Called before draining; returning true means someone else (the comms broker) takes this turn. */
  setPreempt(fn: (unitId: string) => boolean): void {
    this.#preempt = fn;
  }

  constructor(deps: OrderServiceDeps) {
    super((err, ev) => deps.log.error({ err, ev }, "OrderService listener threw"));
    this.#deps = deps;
    deps.units.on("turnFinished", (unit) => void this.drain(unit.id));
    deps.units.on("status", (unit, prev) => {
      if ((unit.status === "idle" && prev !== "idle") || unit.status === "done") void this.drain(unit.id);
    });
    deps.units.on("started", (unit) => void this.drain(unit.id));
  }

  pending(unitId: string): Order[] {
    return this.#deps.stores.orders.pending(unitId);
  }

  async enqueue(
    unitId: string,
    text: string,
    source: OrderSource,
    opts: { interrupt?: boolean } = {},
  ): Promise<{ orderId: string; queued: boolean }> {
    const { fleet, units, stores } = this.#deps;
    const unit = fleet.getUnit(unitId);
    const order: Order = { id: nanoid(10), unitId, text, source, createdAt: Date.now() };

    const running = units.runtime(unitId);
    if (!running) {
      stores.orders.insert(order);
      this.#syncQueueLength(unitId);
      if (this.#deps.autoStartOnOrder !== false) {
        units.start(unitId).catch((err) => this.#deps.log.warn({ err, unitId }, "auto-start on order failed"));
      }
      return { orderId: order.id, queued: true };
    }

    if (units.canAcceptTurn(unitId) && this.pending(unitId).length === 0) {
      stores.orders.insert(order);
      this.#syncQueueLength(unitId);
      await this.drain(unitId);
      return { orderId: order.id, queued: false };
    }

    if (opts.interrupt && (unit.status === "working" || unit.status === "waiting")) {
      stores.orders.insert(order, stores.orders.minPosition(unitId) - 1);
      this.#syncQueueLength(unitId);
      await units.interrupt(unitId);
      // the interrupted result triggers drain(); the front order goes next
      return { orderId: order.id, queued: false };
    }

    stores.orders.insert(order);
    this.#syncQueueLength(unitId);
    void this.drain(unitId);
    return { orderId: order.id, queued: true };
  }

  remove(unitId: string, orderId: string): void {
    this.#deps.fleet.getUnit(unitId);
    if (!this.#deps.stores.orders.remove(orderId)) throw notFound("order", orderId);
    this.#syncQueueLength(unitId);
  }

  /** Submit the next pending order if the unit can take a turn. Safe to call often. */
  async drain(unitId: string): Promise<void> {
    if (this.#draining.has(unitId)) return;
    const { units, stores } = this.#deps;
    if (!units.canAcceptTurn(unitId)) return;
    if (this.#preempt?.(unitId)) return;
    const next = stores.orders.pending(unitId)[0];
    if (!next) {
      this.emit("queueEmpty", unitId);
      return;
    }
    this.#draining.add(unitId);
    try {
      const at = Date.now();
      stores.orders.markSubmitted(next.id, at);
      this.#syncQueueLength(unitId);
      const source: OrderSource = next.source === "operator" && at - next.createdAt > 1500 ? "queue" : next.source;
      const p = units.submit(unitId, next.text, source);
      this.emit("submitted", { ...next, submittedAt: at });
      p.catch((err) => this.#deps.log.warn({ err, unitId }, "turn failed"));
    } catch (err) {
      this.#deps.log.warn({ err, unitId }, "drain failed");
    } finally {
      this.#draining.delete(unitId);
    }
  }

  #syncQueueLength(unitId: string): void {
    const n = this.#deps.stores.orders.pending(unitId).length;
    const u = this.#deps.fleet.units.get(unitId);
    if (!u || u.queueLength === n) return;
    const next = this.#deps.fleet.updateUnit(unitId, { queueLength: n });
    this.#deps.bus.publish({ type: "unit.upsert", unit: next });
  }
}
