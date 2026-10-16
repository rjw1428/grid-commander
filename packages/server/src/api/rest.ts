import type { FastifyInstance } from "fastify";
import {
  BroadcastBodySchema,
  CreateProjectBodySchema,
  CreateTeamBodySchema,
  CreateUnitBodySchema,
  MessagesQuerySchema,
  OperatorMessageBodySchema,
  OrderBodySchema,
  PatchProjectBodySchema,
  PatchSettingsBodySchema,
  PatchTeamBodySchema,
  PatchUnitBodySchema,
  PermissionAnswerBodySchema,
  PushSubscriptionBodySchema,
  QuestionAnswerBodySchema,
  TranscriptQuerySchema,
  type Unit,
  DirQuerySchema,
} from "@gridcommander/shared";
import type { ZodType } from "zod";
import { badRequest } from "../errors.js";
import { listDirs } from "./fsBrowse.js";
import type { Hub } from "../hub.js";

function parse<T>(schema: ZodType<T>, data: unknown): T {
  const r = schema.safeParse(data);
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "body"}: ${i.message}`).join("; ");
    throw badRequest(msg, "validation");
  }
  return r.data;
}

const id = (p: unknown) => (p as { id: string }).id;

export interface RestDeps {
  /** directories the working-directory picker may browse (none → picker disabled) */
  browseRoots?: string[];
  hub: Hub;
  /** M5: operator messages + broadcast go through the comms broker when present. */
  comms?: {
    sendOperatorMessage(body: import("@gridcommander/shared").OperatorMessageBody): Promise<unknown>;
  };
  push?: {
    vapidPublicKey?: string;
  };
}

/** All operator commands. Mounted under /api behind the bearer auth hook. */
export function registerRest(api: FastifyInstance, deps: RestDeps): void {
  const { hub } = deps;
  const { fleet, units, orders, alerts, stores } = hub;

  api.get("/state", async () => hub.snapshot());

  // ------------------------------------------------------------------ units
  api.get("/units", async () => [...fleet.units.values()]);

  api.get("/units/:id", async (req) => {
    const unit = fleet.getUnit(id(req.params));
    return { ...unit, orders: orders.pending(unit.id) };
  });

  api.get("/units/:id/transcript", async (req) => {
    const q = parse(TranscriptQuerySchema, req.query);
    return { entries: units.transcript(id(req.params), q) };
  });

  api.get("/units/:id/orders", async (req) => orders.pending(fleet.getUnit(id(req.params)).id));

  api.get("/units/:id/transcript.md", async (req, reply) => {
    const unit = fleet.getUnit(id(req.params));
    const entries = units.transcript(unit.id, { limit: 5000 });
    reply.header("content-type", "text/markdown; charset=utf-8").header("content-disposition", `attachment; filename="${unit.name}-transcript.md"`);
    return transcriptToMarkdown(unit.name, entries);
  });

  api.get("/units/:id/messages", async (req) => {
    const unit = fleet.getUnit(id(req.params));
    const q = parse(MessagesQuerySchema, req.query);
    return { messages: stores.messages.query({ unitId: unit.id, limit: q.limit }) };
  });

  api.post("/units", async (req, reply) => {
    const body = parse(CreateUnitBodySchema, req.body);
    const unit = fleet.createUnit(body);
    if (body.start || body.firstOrder) {
      try {
        await units.start(unit.id);
      } catch (err) {
        if (!body.firstOrder) throw err;
        api.log.warn({ err, unitId: unit.id }, "start after recruit failed");
      }
    }
    if (body.firstOrder) await orders.enqueue(unit.id, body.firstOrder, "operator");
    reply.code(201);
    return fleet.getUnit(unit.id);
  });

  api.patch("/units/:id", async (req) => {
    const body = parse(PatchUnitBodySchema, req.body);
    const unitId = id(req.params);
    const before = fleet.getUnit(unitId);
    const unit = fleet.patchUnit(unitId, body);
    if (body.model && body.model !== before.model) await units.setModel(unitId, body.model);
    if (body.permissionMode && body.permissionMode !== before.permissionMode) await units.setPermissionMode(unitId, body.permissionMode);
    return unit;
  });

  api.delete("/units/:id", async (req, reply) => {
    await units.remove(fleet.getUnit(id(req.params)).id);
    reply.code(204);
    return null;
  });

  api.post("/units/:id/start", async (req) => units.start(id(req.params)));
  api.post("/units/:id/stop", async (req) => units.stop(id(req.params)));
  api.post("/units/:id/interrupt", async (req) => {
    const unitId = id(req.params);
    fleet.getUnit(unitId);
    await units.interrupt(unitId);
    return fleet.getUnit(unitId);
  });
  api.post("/units/:id/ack", async (req) => units.ack(id(req.params)));

  api.post("/units/:id/orders", async (req, reply) => {
    const body = parse(OrderBodySchema, req.body);
    const res = await orders.enqueue(id(req.params), body.text, "operator", { interrupt: body.interrupt });
    reply.code(201);
    return res;
  });

  api.delete("/units/:id/orders/:orderId", async (req, reply) => {
    const p = req.params as { id: string; orderId: string };
    orders.remove(p.id, p.orderId);
    reply.code(204);
    return null;
  });

  api.post("/units/:id/permission", async (req) => {
    const body = parse(PermissionAnswerBodySchema, req.body);
    return units.answerPermission(id(req.params), body);
  });

  api.post("/units/:id/answer", async (req) => {
    const body = parse(QuestionAnswerBodySchema, req.body);
    return units.answerQuestion(id(req.params), body.answers);
  });

  api.post("/units/:id/compact", async (req, reply) => {
    const res = await orders.enqueue(id(req.params), "/compact", "operator");
    reply.code(201);
    return res;
  });

  api.get("/units/:id/context", async (req) => {
    const unitId = id(req.params);
    fleet.getUnit(unitId);
    return { usage: await units.contextUsage(unitId) };
  });

  // ------------------------------------------------------------------ broadcast / messages
  api.post("/broadcast", async (req) => {
    const body = parse(BroadcastBodySchema, req.body);
    const targets = resolveBroadcast(body.to, [...fleet.units.values()], fleet);
    const sent: string[] = [];
    const queued: string[] = [];
    const skipped: string[] = [];
    for (const u of targets) {
      const busy = u.status === "working" || u.status === "waiting";
      if (busy && !body.queueIfBusy) {
        skipped.push(u.id);
        continue;
      }
      const r = await orders.enqueue(u.id, body.text, "broadcast");
      (r.queued ? queued : sent).push(u.id);
    }
    return { sent, queued, skipped };
  });

  api.post("/messages", async (req, reply) => {
    const body = parse(OperatorMessageBodySchema, req.body);
    const comms = deps.comms ?? hub.comms;
    reply.code(201);
    return comms.sendOperatorMessage(body);
  });

  api.get("/messages", async (req) => {
    const q = parse(MessagesQuerySchema, req.query);
    return { messages: stores.messages.query(q) };
  });

  // ------------------------------------------------------------------ projects / teams
  api.get("/projects", async () => [...fleet.projects.values()]);
  api.post("/projects", async (req, reply) => {
    reply.code(201);
    return fleet.createProject(parse(CreateProjectBodySchema, req.body));
  });
  api.patch("/projects/:id", async (req) => fleet.patchProject(id(req.params), parse(PatchProjectBodySchema, req.body)));
  api.delete("/projects/:id", async (req, reply) => {
    fleet.deleteProject(id(req.params));
    reply.code(204);
    return null;
  });

  api.get("/teams", async () => [...fleet.teams.values()]);
  api.post("/teams", async (req, reply) => {
    reply.code(201);
    return fleet.createTeam(parse(CreateTeamBodySchema, req.body));
  });
  api.patch("/teams/:id", async (req) => fleet.patchTeam(id(req.params), parse(PatchTeamBodySchema, req.body)));
  api.delete("/teams/:id", async (req, reply) => {
    fleet.deleteTeam(id(req.params));
    reply.code(204);
    return null;
  });

  // ------------------------------------------------------------------ alerts / settings / push
  api.get("/alerts", async () => alerts.list());
  api.post("/alerts/:id/dismiss", async (req, reply) => {
    alerts.dismiss(id(req.params));
    reply.code(204);
    return null;
  });
  api.post("/alerts/dismiss-all", async () => ({ dismissed: alerts.dismissAll() }));

  api.get("/settings", async () => hub.settings());
  api.patch("/settings", async (req) => hub.patchSettings(parse(PatchSettingsBodySchema, req.body)));

  api.get("/push/vapid-public-key", async () => ({ key: deps.push?.vapidPublicKey ?? null }));
  api.post("/push/subscribe", async (req, reply) => {
    const body = parse(PushSubscriptionBodySchema, req.body);
    stores.push.upsert(body);
    reply.code(201);
    return { ok: true };
  });
  api.delete("/push/subscribe", async (req) => {
    const body = parse(PushSubscriptionBodySchema.pick({ endpoint: true }), req.body);
    return { removed: stores.push.remove(body.endpoint) };
  });

  api.get("/unit-types", async () => hub.snapshot().unitTypes);

  // ------------------------------------------------------------------ directory browser
  api.get("/fs/dirs", async (req) => {
    const q = parse(DirQuerySchema, req.query ?? {});
    return listDirs(deps.browseRoots ?? [], q.path, q.hidden === "1");
  });
}

export function transcriptToMarkdown(name: string, entries: import("@gridcommander/shared").TranscriptEntry[]): string {
  const ts = (at: number) => new Date(at).toISOString().replace("T", " ").slice(0, 19);
  const out: string[] = [`# ${name} — transcript`, ""];
  for (const e of entries) {
    switch (e.kind) {
      case "user":
        out.push(`## ${ts(e.at)} · ${e.source}`, "", e.text, "");
        break;
      case "assistant":
        out.push(e.text, "");
        break;
      case "tool":
        out.push(`- \`${e.summary}\`${e.ok === false ? " ✗" : e.ok ? " ✓" : ""}${e.durationMs !== undefined ? ` (${e.durationMs} ms)` : ""}`);
        break;
      case "result":
        out.push("", `> **${e.ok ? "result" : "error"}** ${ts(e.at)}${e.costUsd !== undefined ? ` · $${e.costUsd.toFixed(4)}` : ""}`, ">", ...e.text.split("\n").map((l) => `> ${l}`), "");
        break;
      case "message":
        out.push(`- ✉ ${e.direction === "in" ? "in" : "out"}: ${e.text ?? e.messageId}`);
        break;
      case "system":
        out.push(`_${e.text}_`, "");
        break;
    }
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}

export function resolveBroadcast(
  to: { kind: "fleet" } | { kind: "team"; id: string } | { kind: "project"; id: string } | { kind: "units"; ids: string[] },
  all: Unit[],
  fleet: Hub["fleet"],
): Unit[] {
  switch (to.kind) {
    case "fleet":
      return all;
    case "team": {
      const team = fleet.getTeam(to.id);
      return all.filter((u) => team.memberIds.includes(u.id));
    }
    case "project":
      fleet.getProject(to.id);
      return all.filter((u) => u.projectId === to.id);
    case "units":
      return to.ids.map((i) => fleet.getUnit(i));
  }
}
