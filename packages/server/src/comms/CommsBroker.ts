import { nanoid } from "nanoid";
import {
  getUnitType,
  type Message,
  type MessageTarget,
  type OperatorMessageBody,
  type Priority,
  type Settings,
  type Unit,
} from "@gridcommander/shared";
import type { Bus } from "../bus.js";
import { badRequest, notFound } from "../errors.js";
import type { AlertEngine } from "../alerts/AlertEngine.js";
import type { FleetService } from "../fleet/FleetService.js";
import type { OrderService } from "../fleet/OrderService.js";
import type { UnitService } from "../fleet/UnitService.js";
import { Emitter } from "../runtime/emitter.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { Stores } from "../store/stores.js";

export interface CommsDeps {
  stores: Stores;
  fleet: FleetService;
  units: UnitService;
  orders: OrderService;
  alerts: AlertEngine;
  bus: Bus;
  settings: () => Settings;
  log: RuntimeLogger;
  /** PostToolUse nudge throttle. */
  nudgeIntervalMs?: number;
}

export interface SendInput {
  from: string; // unit id or "operator"
  to: MessageTarget;
  body: string;
  priority: Priority;
  replyTo?: string;
  relayedFrom?: string;
}

export interface SendResult {
  message: Message;
  recipients: string[];
  delivery: "turn" | "queued" | "interrupt" | "none";
  downgraded?: boolean;
}

export class CommsDenied extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommsDenied";
  }
}

const fmtTime = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const shortId = (id: string) => id.slice(0, 4);

/** The switchboard: who may message whom, and how a message reaches a session. */
export class CommsBroker extends Emitter<{ delivered: (messageId: string, unitId: string, how: "turn" | "interrupt" | "tool") => void }> {
  #d: CommsDeps;
  #urgentPending = new Set<string>();
  #lastNudge = new Map<string, number>();

  constructor(deps: CommsDeps) {
    super((err, ev) => deps.log.error({ err, ev }, "CommsBroker listener threw"));
    this.#d = deps;
    deps.orders.setPreempt((unitId) => this.#preemptDrain(unitId));
    deps.orders.on("queueEmpty", (unitId) => void this.deliverInbox(unitId));
    deps.units.on("started", (unit) => void this.deliverInbox(unit.id));
    deps.units.on("status", (unit, prev) => {
      // an urgent message waited behind a permission prompt: interrupt once the answer resumes the turn
      if (prev === "waiting" && unit.status === "working" && this.#urgentPending.has(unit.id)) {
        void deps.units.interrupt(unit.id).catch((err) => deps.log.warn({ err, unitId: unit.id }, "urgent interrupt after permission failed"));
      }
    });
  }

  // ------------------------------------------------------------------ policy

  canSend(from: Unit, to: Unit): { ok: true } | { ok: false; reason: string } {
    if (from.id === to.id) return { ok: false, reason: "you cannot message yourself" };
    if (this.#d.settings()["comms.crossProject"]) return { ok: true };
    if (from.projectId === to.projectId) return { ok: true };
    if (from.teamId && from.teamId === to.teamId) return { ok: true };
    if (to.type === "general") return { ok: true };
    const type = getUnitType(from.type);
    if (type.commsScope === "fleet") return { ok: true };
    return {
      ok: false,
      reason: `${from.name} (${type.name}) may only message units in project "${from.projectId}"${from.teamId ? ` or team "${from.teamId}"` : ""}. ${to.name} is in project "${to.projectId}". Send to "general" to escalate instead.`,
    };
  }

  /** Units a caller may address at a given scope (clamped to the caller type's commsScope). */
  roster(caller: Unit, scope: "project" | "team" | "fleet" = "project"): Unit[] {
    const type = getUnitType(caller.type);
    const allowed = this.#d.settings()["comms.crossProject"] ? "fleet" : type.commsScope;
    const rank = { project: 0, team: 1, fleet: 2 } as const;
    const effective = rank[scope] > rank[allowed] ? allowed : scope;
    const all = [...this.#d.fleet.units.values()].filter((u) => u.id !== caller.id);
    const generals = all.filter((u) => u.type === "general");
    let base: Unit[];
    if (effective === "fleet") base = all;
    else if (effective === "team") base = caller.teamId ? all.filter((u) => u.teamId === caller.teamId || u.projectId === caller.projectId) : all.filter((u) => u.projectId === caller.projectId);
    else base = all.filter((u) => u.projectId === caller.projectId);
    const ids = new Set(base.map((u) => u.id));
    for (const g of generals) if (!ids.has(g.id)) base.push(g);
    return base;
  }

  resolveRecipients(from: Unit | "operator", to: MessageTarget): Unit[] {
    const { fleet } = this.#d;
    const all = [...fleet.units.values()];
    const self = from === "operator" ? undefined : from.id;
    switch (to.kind) {
      case "unit": {
        const u = fleet.units.get(to.id) ?? all.find((x) => x.name === to.id);
        if (!u) throw notFound("unit", to.id);
        return [u];
      }
      case "team": {
        const t = fleet.getTeam(to.id);
        return all.filter((u) => t.memberIds.includes(u.id) && u.id !== self);
      }
      case "project":
        fleet.getProject(to.id);
        return all.filter((u) => u.projectId === to.id && u.id !== self);
      case "fleet":
        return all.filter((u) => u.id !== self);
    }
  }

  /** Agent-facing target syntax: unit id | "team" | "project" | "general". */
  targetFor(caller: Unit, to: string): MessageTarget {
    if (to === "team") {
      if (!caller.teamId) throw new CommsDenied(`${caller.name} is not in a team; address a unit id, "project" or "general"`);
      return { kind: "team", id: caller.teamId };
    }
    if (to === "project") return { kind: "project", id: caller.projectId };
    if (to === "general") {
      const g = [...this.#d.fleet.units.values()].find((u) => u.type === "general");
      if (!g) throw new CommsDenied("no General is deployed; escalate to the operator in your final message instead");
      return { kind: "unit", id: g.id };
    }
    return { kind: "unit", id: to };
  }

  // ------------------------------------------------------------------ sending

  async send(input: SendInput): Promise<SendResult> {
    const { fleet, stores, bus, alerts } = this.#d;
    const fromUnit = input.from === "operator" ? "operator" : fleet.getUnit(input.from);
    let recipients: Unit[];
    try {
      recipients = this.resolveRecipients(fromUnit, input.to);
    } catch (err) {
      if (err instanceof Error && (err as { statusCode?: number }).statusCode === 404) throw new CommsDenied(err.message);
      throw err;
    }
    if (fromUnit !== "operator") {
      const denied = recipients.map((r) => ({ r, v: this.canSend(fromUnit, r) })).filter((x) => !x.v.ok);
      if (input.to.kind === "unit" && denied.length) throw new CommsDenied((denied[0]!.v as { reason: string }).reason);
      recipients = recipients.filter((r) => this.canSend(fromUnit, r).ok);
    }
    if (!recipients.length) throw new CommsDenied("no recipient matched that target");

    let priority = input.priority;
    let downgraded = false;
    if (priority === "urgent" && fromUnit !== "operator") {
      const type = getUnitType(fromUnit.type);
      const anyBusy = recipients.some((r) => r.status === "working" || r.status === "waiting");
      if (!type.canInterrupt && anyBusy) {
        priority = "normal";
        downgraded = true;
      }
    }
    if (priority === "urgent" && !recipients.some((r) => r.status === "working" || r.status === "waiting")) {
      priority = "normal";
      downgraded = true;
    }

    let replyTo = input.replyTo ? (stores.messages.get(input.replyTo) ?? stores.messages.query({ threadId: input.replyTo, limit: 1 })[0]) : undefined;
    // Implicit threading: a unit answering the unit that last wrote to it stays in that thread even
    // when the model forgets replyTo.
    if (!replyTo && fromUnit !== "operator" && input.to.kind === "unit" && recipients.length === 1) {
      const recent = stores.messages
        .query({ unitId: fromUnit.id, limit: 50 })
        .filter((m) => m.from === recipients[0]!.id && fromUnit.id in m.deliveries && Date.now() - m.createdAt < 3_600_000)
        .at(-1);
      if (recent) replyTo = recent;
    }
    const id = nanoid(10);
    const message: Message = {
      id,
      from: input.from,
      to: input.to,
      body: input.body,
      priority,
      threadId: replyTo?.threadId ?? id,
      ...(replyTo ? { replyTo: replyTo.id } : {}),
      createdAt: Date.now(),
      deliveries: Object.fromEntries(recipients.map((r) => [r.id, {}])),
      ...(input.relayedFrom ? { relayedFrom: input.relayedFrom } : {}),
    };
    stores.messages.insert(message);
    bus.publish({ type: "message.new", message });

    if (fromUnit !== "operator") {
      stores.transcript.append(fromUnit.id, [{ kind: "message", at: message.createdAt, messageId: id, direction: "out", text: `→ ${recipients.map((r) => r.name).join(", ")}: ${input.body.slice(0, 500)}` }]);
      bus.publish({ type: "unit.transcript", unitId: fromUnit.id, entries: [{ kind: "message", at: message.createdAt, messageId: id, direction: "out", text: `→ ${recipients.map((r) => r.name).join(", ")}: ${input.body.slice(0, 500)}` }] });
    }
    for (const r of recipients) this.#bumpUnread(r.id);

    if (priority === "urgent" || recipients.some((r) => r.type === "general")) {
      const fromName = fromUnit === "operator" ? "operator" : fromUnit.name;
      for (const r of recipients.filter((x) => priority === "urgent" || x.type === "general")) {
        alerts.raise({ kind: "message", unitId: r.id, title: `${priority === "urgent" ? "Urgent " : ""}message for ${r.name}`, body: `from ${fromName}: ${input.body.slice(0, 140)}`, payload: { messageId: id } });
      }
    }

    let delivery: SendResult["delivery"] = "none";
    for (const r of recipients) {
      const how = await this.#deliverTo(r.id, priority);
      if (how === "interrupt") delivery = "interrupt";
      else if (how === "turn" && delivery !== "interrupt") delivery = "turn";
      else if (how === "queued" && delivery === "none") delivery = "queued";
    }
    return { message, recipients: recipients.map((r) => r.id), delivery, ...(downgraded ? { downgraded } : {}) };
  }

  async sendOperatorMessage(body: OperatorMessageBody): Promise<SendResult> {
    let text = body.body;
    if (body.relayedFrom) {
      const src = this.#d.fleet.getUnit(body.relayedFrom);
      const out = (src.lastResult?.text ?? "").slice(0, 2000);
      if (!out) throw badRequest(`${src.name} has no result to relay yet`, "nothing_to_relay");
      text = `${body.body.trim() ? body.body.trim() + "\n\n" : ""}[Relayed output of ${src.name}]\n${out}`;
    }
    try {
      return await this.send({ from: "operator", to: body.to, body: text, priority: body.priority, replyTo: body.replyTo, relayedFrom: body.relayedFrom });
    } catch (err) {
      if (err instanceof CommsDenied) throw badRequest(err.message, "comms_denied");
      throw err;
    }
  }

  // ------------------------------------------------------------------ delivery

  async #deliverTo(unitId: string, priority: Priority): Promise<"turn" | "queued" | "interrupt"> {
    const { fleet, units } = this.#d;
    const unit = fleet.units.get(unitId);
    if (!unit) return "queued";
    if (priority === "urgent" && (unit.status === "working" || unit.status === "waiting")) {
      this.#urgentPending.add(unitId);
      if (unit.status === "working") {
        await units.interrupt(unitId); // preempt() delivers the inbox at the turn boundary
      }
      return "interrupt";
    }
    const delivered = await this.deliverInbox(unitId);
    return delivered ? "turn" : "queued";
  }

  /** Turn-boundary delivery. Submits the inbox as a user turn when the unit can take one. */
  async deliverInbox(unitId: string, opts: { force?: boolean } = {}): Promise<boolean> {
    const { units, orders, stores } = this.#d;
    if (!units.canAcceptTurn(unitId)) return false;
    if (!opts.force && !this.#urgentPending.has(unitId) && orders.pending(unitId).length > 0) return false;
    const pending = stores.messages.unreadFor(unitId).filter((m) => !m.deliveries[unitId]?.deliveredAt);
    if (!pending.length) {
      this.#urgentPending.delete(unitId);
      return false;
    }
    const urgent = this.#urgentPending.has(unitId) || pending.some((m) => m.priority === "urgent");
    this.#urgentPending.delete(unitId);
    const at = Date.now();
    const text = this.formatInboxTurn(pending, urgent);
    for (const m of pending) {
      stores.messages.markDelivered(m.id, unitId, urgent ? "interrupt" : "turn", at, true);
      this.emit("delivered", m.id, unitId, urgent ? "interrupt" : "turn");
    }
    this.#syncUnread(unitId);
    stores.transcript.append(unitId, pending.map((m) => ({ kind: "message" as const, at, messageId: m.id, direction: "in" as const, text: `← ${this.#nameOf(m.from)}: ${m.body.slice(0, 500)}` })));
    this.#d.bus.publish({ type: "unit.transcript", unitId, entries: pending.map((m) => ({ kind: "message" as const, at, messageId: m.id, direction: "in" as const, text: `← ${this.#nameOf(m.from)}: ${m.body.slice(0, 500)}` })) });
    try {
      units.submit(unitId, text, urgent ? "urgent" : "inbox").catch((err) => this.#d.log.warn({ err, unitId }, "inbox turn failed"));
    } catch (err) {
      this.#d.log.warn({ err, unitId }, "inbox submit refused");
      return false;
    }
    return true;
  }

  /** OrderService asks before draining a queued order; urgent inbox wins. */
  #preemptDrain(unitId: string): boolean {
    if (!this.#urgentPending.has(unitId)) return false;
    void this.deliverInbox(unitId, { force: true });
    return true;
  }

  formatInboxTurn(msgs: Message[], urgent: boolean): string {
    const lines: string[] = [];
    if (urgent) {
      const m = msgs.find((x) => x.priority === "urgent") ?? msgs[0]!;
      lines.push(`[URGENT message from ${this.#nameOf(m.from)} (${this.#rankOf(m.from)})]`);
      lines.push("");
    }
    lines.push(`[fleet inbox — ${msgs.length} message${msgs.length === 1 ? "" : "s"}]`);
    lines.push("");
    msgs.forEach((m, i) => {
      const reply = m.replyTo ? `, reply-to ${shortId(m.replyTo)}` : "";
      const relayed = m.relayedFrom ? ` (relayed by operator from ${this.#nameOf(m.relayedFrom)})` : "";
      lines.push(`${i + 1}. from ${this.#nameOf(m.from)} (${this.#rankOf(m.from)})${relayed}, thread ${shortId(m.threadId)}, ${fmtTime(m.createdAt)}${reply}${m.priority === "urgent" ? " [urgent]" : ""}`);
      for (const l of m.body.split("\n")) lines.push(`   ${l}`);
      lines.push("");
    });
    lines.push(
      `Reply with fleet_send(to=<sender id>, replyTo=<thread>) only if the sender needs an answer or something from you. Do not send acknowledgements, thanks or status chatter. Then continue your current orders.`,
    );
    return lines.join("\n");
  }

  // ------------------------------------------------------------------ tools

  /** fleet_inbox: unread messages for the caller; marks them read/delivered via the tool path. */
  pullInbox(unitId: string, markRead = true): Message[] {
    const { stores } = this.#d;
    const msgs = stores.messages.unreadFor(unitId);
    if (markRead) {
      const at = Date.now();
      for (const m of msgs) {
        stores.messages.markDelivered(m.id, unitId, "tool", at, true);
        this.emit("delivered", m.id, unitId, "tool");
      }
      this.#syncUnread(unitId);
    }
    return msgs;
  }

  /** PostToolUse hook nudge, at most once per interval per unit and only while unread > 0. */
  nudge(unitId: string, now = Date.now()): string | undefined {
    const unread = this.#d.stores.messages.unreadFor(unitId);
    if (!unread.length) return undefined;
    const last = this.#lastNudge.get(unitId) ?? 0;
    if (now - last < (this.#d.nudgeIntervalMs ?? 90_000)) return undefined;
    this.#lastNudge.set(unitId, now);
    const names = [...new Set(unread.map((m) => this.#nameOf(m.from)))].slice(0, 3).join(", ");
    return `[fleet] You have ${unread.length} unread message${unread.length === 1 ? "" : "s"} (from ${names}). Call fleet_inbox when you reach a good stopping point.`;
  }

  report(unitId: string, input: { task?: string; note?: string; done?: boolean }): void {
    const { fleet, alerts, bus } = this.#d;
    const unit = fleet.getUnit(unitId);
    const patch: Partial<Unit> = {};
    if (typeof input.task === "string") patch.task = input.task.slice(0, 200);
    if (input.done !== undefined) patch.missionDone = input.done || undefined;
    if (Object.keys(patch).length) bus.publish({ type: "unit.upsert", unit: fleet.updateUnit(unitId, patch) });
    if (input.note) {
      const at = Date.now();
      this.#d.stores.transcript.append(unitId, [{ kind: "system", at, text: `report: ${input.note.slice(0, 300)}` }]);
      bus.publish({ type: "unit.transcript", unitId, entries: [{ kind: "system", at, text: `report: ${input.note.slice(0, 300)}` }] });
      alerts.raise({ kind: "info", unitId, title: unit.name, body: input.note.slice(0, 200) });
    }
    if (input.done) alerts.raise({ kind: "info", unitId, title: `${unit.name} reports mission complete`, body: (input.note ?? unit.task).slice(0, 200) });
  }

  async requestReview(unitId: string, summary: string, paths: string[] = []): Promise<SendResult> {
    const { fleet } = this.#d;
    const unit = fleet.getUnit(unitId);
    const all = [...fleet.units.values()];
    const captain = all.find((u) => u.type === "captain" && u.projectId === unit.projectId && u.id !== unit.id);
    const general = all.find((u) => u.type === "general");
    const target = captain ?? general;
    if (!target) throw new CommsDenied("no Captain in this project and no General deployed");
    const body = [`Review request from ${unit.name} (${unit.projectId}).`, ``, summary.trim(), paths.length ? `` : ``, paths.length ? `Paths:\n${paths.map((p) => `- ${p}`).join("\n")}` : ``, ``, `Reply in-thread with a verdict first, then findings by severity.`]
      .filter((l, i, a) => !(l === "" && a[i - 1] === ""))
      .join("\n");
    return this.send({ from: unitId, to: { kind: "unit", id: target.id }, body, priority: "normal" });
  }

  // ------------------------------------------------------------------ helpers

  #nameOf(id: string): string {
    if (id === "operator") return "operator";
    return this.#d.fleet.units.get(id)?.name ?? id;
  }
  #rankOf(id: string): string {
    if (id === "operator") return "Operator";
    const u = this.#d.fleet.units.get(id);
    return u ? getUnitType(u.type).name : "unknown";
  }
  #bumpUnread(unitId: string): void {
    this.#syncUnread(unitId);
  }
  #syncUnread(unitId: string): void {
    const n = this.#d.stores.messages.unreadCount(unitId);
    const u = this.#d.fleet.units.get(unitId);
    if (!u || u.unreadInbox === n) return;
    this.#d.bus.publish({ type: "unit.upsert", unit: this.#d.fleet.updateUnit(unitId, { unreadInbox: n }) });
  }
}
