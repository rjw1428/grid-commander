import { z } from "zod";
import { getUnitType, type Unit } from "@gridcommander/shared";
import type { SdkFacade } from "../runtime/UnitRuntime.js";
import type { McpServerConfig } from "../runtime/sdkTypes.js";
import { CommsBroker, CommsDenied } from "./CommsBroker.js";

export type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
const ok = (text: string): ToolResult => ({ content: [{ type: "text", text }] });
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text: `Error: ${text}` }], isError: true });
const guard = async (fn: () => Promise<ToolResult> | ToolResult): Promise<ToolResult> => {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CommsDenied) return fail(err.message);
    return fail(err instanceof Error ? err.message : String(err));
  }
};

export const FLEET_TOOL_NAMES = ["fleet_roster", "fleet_send", "fleet_inbox", "fleet_report", "fleet_request_review"] as const;
export type FleetToolName = (typeof FLEET_TOOL_NAMES)[number];

/** Fleet tools a unit of this type may use (names without the mcp__fleet__ prefix). */
export function fleetToolsForUnit(unit: Unit): FleetToolName[] {
  const type = getUnitType(unit.type);
  const enabled = new Set(type.tools ?? FLEET_TOOL_NAMES);
  return FLEET_TOOL_NAMES.filter((n) => enabled.has(n));
}

/** Input schemas, shared by the MCP server (which validates in the session process) and the hub-side handlers. */
export const FLEET_TOOL_SCHEMAS = {
  fleet_roster: { scope: z.enum(["project", "team", "fleet"]).optional().describe("project (default), team, or fleet") },
  fleet_send: {
    to: z.string().describe('unit id, "team", "project" or "general"'),
    body: z.string().min(1).max(20_000),
    priority: z.enum(["normal", "urgent"]).optional(),
    replyTo: z.string().optional().describe("thread or message id you are replying to"),
  },
  fleet_inbox: { markRead: z.boolean().optional().describe("default true") },
  fleet_report: {
    task: z.string().max(200).optional(),
    note: z.string().max(500).optional(),
    done: z.boolean().optional(),
  },
  fleet_request_review: { summary: z.string().min(1).max(4000), paths: z.array(z.string()).optional() },
} as const;

const FLEET_TOOL_DESCRIPTIONS: Record<FleetToolName, string> = {
  fleet_roster:
    "List the other units you may message: id, name, rank, project, status, mission and current activity. Scope defaults to your project; wider scopes are clamped to what your rank allows.",
  fleet_send:
    'Send a message to another unit. `to` is a unit id, "team" (your team), "project" (your project), or "general". Normal priority is delivered when the recipient reaches a stopping point; urgent interrupts them (only if your rank may interrupt, and only when your message invalidates their current work). Use replyTo with a thread id to answer in-thread.',
  fleet_inbox: "Read your unread messages from other units and the operator, oldest first. Marks them read.",
  fleet_report:
    "Update your mission line (task, ≤80 chars) and/or post a one-line progress note to the operator. Set done=true when the mission is complete.",
  fleet_request_review: "Ask the nearest Captain in your project (or the General) to review your work. Include a short summary and the paths touched.",
};

/** Hub-side execution of one fleet tool call. The unit id comes from the session binding, never from the model. */
export type FleetToolCall = (name: string, args: Record<string, unknown>) => Promise<ToolResult>;

/**
 * Runs fleet tool calls against the broker. Used directly when the runtime is in-process and via
 * the host bridge when sessions live in the unit host process.
 */
export function fleetToolHandler(unitId: string, getUnit: () => Unit, broker: CommsBroker): FleetToolCall {
  return (name, rawArgs) =>
    guard(async () => {
      const allowed = new Set<string>(fleetToolsForUnit(getUnit()));
      if (!allowed.has(name)) return fail(`tool ${name} is not available to this unit`);
      switch (name as FleetToolName) {
        case "fleet_roster": {
          const args = z.object(FLEET_TOOL_SCHEMAS.fleet_roster).parse(rawArgs);
          const rows = broker.roster(getUnit(), args.scope ?? "project").map((u) => {
            const t = getUnitType(u.type);
            return `- ${u.id} — ${u.name} (${t.name}, ${t.rank}) · project ${u.projectId}${u.teamId ? ` · team ${u.teamId}` : ""} · ${u.status}${u.task ? ` · mission: ${u.task}` : ""}${u.activity ? ` · now: ${u.activity}` : ""}`;
          });
          return ok(rows.length ? rows.join("\n") : "No other units are addressable at this scope.");
        }
        case "fleet_send": {
          const args = z.object(FLEET_TOOL_SCHEMAS.fleet_send).parse(rawArgs);
          const caller = getUnit();
          const target = broker.targetFor(caller, args.to);
          const r = await broker.send({ from: unitId, to: target, body: args.body, priority: args.priority ?? "normal", replyTo: args.replyTo });
          const names = r.recipients.join(", ");
          return ok(
            `Sent message ${r.message.id} (thread ${r.message.threadId}) to ${names}. Delivery: ${r.delivery === "interrupt" ? "interrupt" : r.delivery === "turn" ? "delivered now" : "queued until they reach a stopping point"}${r.downgraded ? " (urgent was downgraded to normal)" : ""}.`,
          );
        }
        case "fleet_inbox": {
          const args = z.object(FLEET_TOOL_SCHEMAS.fleet_inbox).parse(rawArgs);
          const msgs = broker.pullInbox(unitId, args.markRead ?? true);
          if (!msgs.length) return ok("Inbox empty.");
          return ok(broker.formatInboxTurn(msgs, false));
        }
        case "fleet_report": {
          const args = z.object(FLEET_TOOL_SCHEMAS.fleet_report).parse(rawArgs);
          broker.report(unitId, args);
          return ok("Reported.");
        }
        case "fleet_request_review": {
          const args = z.object(FLEET_TOOL_SCHEMAS.fleet_request_review).parse(rawArgs);
          const r = await broker.requestReview(unitId, args.summary, args.paths ?? []);
          return ok(`Review requested from ${r.recipients.join(", ")} (thread ${r.message.threadId}).`);
        }
      }
    });
}

/**
 * Builds the in-process `fleet` MCP server for one unit. Every tool forwards to `call`, which runs
 * in the hub (directly, or across the host bridge). Tool names reach the model as mcp__fleet__<name>.
 */
export function fleetServer(sdk: SdkFacade, tools: readonly string[], call: FleetToolCall): McpServerConfig {
  const defs = [];
  for (const name of FLEET_TOOL_NAMES) {
    if (!tools.includes(name)) continue;
    defs.push(
      sdk.tool(name, FLEET_TOOL_DESCRIPTIONS[name], FLEET_TOOL_SCHEMAS[name] as Record<string, z.ZodTypeAny>, async (args) =>
        call(name, args as Record<string, unknown>).catch((err) => fail(err instanceof Error ? err.message : String(err))),
      ),
    );
  }
  return sdk.createSdkMcpServer({ name: "fleet", version: "1.0.0", tools: defs, alwaysLoad: true });
}

/** Convenience for the in-process runtime: handler and server bound to the same broker. */
export function fleetServerForUnit(sdk: SdkFacade, unitId: string, getUnit: () => Unit, broker: CommsBroker): McpServerConfig {
  return fleetServer(sdk, fleetToolsForUnit(getUnit()), fleetToolHandler(unitId, getUnit, broker));
}
