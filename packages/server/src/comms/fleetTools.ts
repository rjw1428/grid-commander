import { z } from "zod";
import { getUnitType, type Unit } from "@gridcommander/shared";
import type { SdkFacade } from "../runtime/UnitRuntime.js";
import type { McpServerConfig } from "../runtime/sdkTypes.js";
import { CommsBroker, CommsDenied } from "./CommsBroker.js";

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };
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

/**
 * Builds the in-process `fleet` MCP server for one unit. The unit id is closed over, so a session
 * cannot spoof `from`. Tool names reach the model as mcp__fleet__<name>.
 */
export function fleetServerForUnit(sdk: SdkFacade, unitId: string, getUnit: () => Unit, broker: CommsBroker): McpServerConfig {
  const type = getUnitType(getUnit().type);
  const enabled = new Set(type.tools ?? FLEET_TOOL_NAMES);
  const tools = [];

  if (enabled.has("fleet_roster")) {
    tools.push(
      sdk.tool(
        "fleet_roster",
        "List the other units you may message: id, name, rank, project, status, mission and current activity. Scope defaults to your project; wider scopes are clamped to what your rank allows.",
        { scope: z.enum(["project", "team", "fleet"]).optional().describe("project (default), team, or fleet") },
        async (args) =>
          guard(() => {
            const rows = broker.roster(getUnit(), args.scope ?? "project").map((u) => {
              const t = getUnitType(u.type);
              return `- ${u.id} — ${u.name} (${t.name}, ${t.rank}) · project ${u.projectId}${u.teamId ? ` · team ${u.teamId}` : ""} · ${u.status}${u.task ? ` · mission: ${u.task}` : ""}${u.activity ? ` · now: ${u.activity}` : ""}`;
            });
            return ok(rows.length ? rows.join("\n") : "No other units are addressable at this scope.");
          }),
      ),
    );
  }

  if (enabled.has("fleet_send")) {
    tools.push(
      sdk.tool(
        "fleet_send",
        'Send a message to another unit. `to` is a unit id, "team" (your team), "project" (your project), or "general". Normal priority is delivered when the recipient reaches a stopping point; urgent interrupts them (only if your rank may interrupt, and only when your message invalidates their current work). Use replyTo with a thread id to answer in-thread.',
        {
          to: z.string().describe('unit id, "team", "project" or "general"'),
          body: z.string().min(1).max(20_000),
          priority: z.enum(["normal", "urgent"]).optional(),
          replyTo: z.string().optional().describe("thread or message id you are replying to"),
        },
        async (args) =>
          guard(async () => {
            const caller = getUnit();
            const target = broker.targetFor(caller, args.to);
            const r = await broker.send({ from: unitId, to: target, body: args.body, priority: args.priority ?? "normal", replyTo: args.replyTo });
            const names = r.recipients.join(", ");
            return ok(
              `Sent message ${r.message.id} (thread ${r.message.threadId}) to ${names}. Delivery: ${r.delivery === "interrupt" ? "interrupt" : r.delivery === "turn" ? "delivered now" : "queued until they reach a stopping point"}${r.downgraded ? " (urgent was downgraded to normal)" : ""}.`,
            );
          }),
      ),
    );
  }

  if (enabled.has("fleet_inbox")) {
    tools.push(
      sdk.tool(
        "fleet_inbox",
        "Read your unread messages from other units and the operator, oldest first. Marks them read.",
        { markRead: z.boolean().optional().describe("default true") },
        async (args) =>
          guard(() => {
            const msgs = broker.pullInbox(unitId, args.markRead ?? true);
            if (!msgs.length) return ok("Inbox empty.");
            return ok(broker.formatInboxTurn(msgs, false));
          }),
      ),
    );
  }

  if (enabled.has("fleet_report")) {
    tools.push(
      sdk.tool(
        "fleet_report",
        "Update your mission line (task, ≤80 chars) and/or post a one-line progress note to the operator. Set done=true when the mission is complete.",
        {
          task: z.string().max(200).optional(),
          note: z.string().max(500).optional(),
          done: z.boolean().optional(),
        },
        async (args) =>
          guard(() => {
            broker.report(unitId, args);
            return ok("Reported.");
          }),
      ),
    );
  }

  if (enabled.has("fleet_request_review")) {
    tools.push(
      sdk.tool(
        "fleet_request_review",
        "Ask the nearest Captain in your project (or the General) to review your work. Include a short summary and the paths touched.",
        { summary: z.string().min(1).max(4000), paths: z.array(z.string()).optional() },
        async (args) =>
          guard(async () => {
            const r = await broker.requestReview(unitId, args.summary, args.paths ?? []);
            return ok(`Review requested from ${r.recipients.join(", ")} (thread ${r.message.threadId}).`);
          }),
      ),
    );
  }

  return sdk.createSdkMcpServer({ name: "fleet", version: "1.0.0", tools, alwaysLoad: true });
}
