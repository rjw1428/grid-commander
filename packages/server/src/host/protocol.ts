/**
 * Wire protocol between the hub (web server) and the unit host (the detached process that owns
 * the Claude sessions). JSON lines over a Unix domain socket. Internal to packages/server: this is
 * not the operator wire, but every frame is still validated with zod on receipt because the two
 * processes may be running different builds.
 */
import { z } from "zod";
import {
  OrderSourceSchema,
  PendingQuestionSchema,
  PermissionModeSchema,
  PermissionRequestSchema,
  TranscriptEntrySchema,
  UnitStatusSchema,
} from "@gridcommander/shared";

export const HOST_PROTOCOL_VERSION = 1;

/** Everything a host needs to build a UnitRuntime for one unit. Functions never cross; see fleet tool bridge. */
export const UnitSpecSchema = z.object({
  unitId: z.string(),
  name: z.string(),
  cwd: z.string(),
  model: z.string(),
  permissionMode: PermissionModeSchema,
  sessionId: z.string().optional(),
  systemPromptAppend: z.string(),
  /** Fleet MCP tools enabled for this unit (names without the mcp__fleet__ prefix); empty = no fleet server. */
  fleetTools: z.array(z.string()),
  /** Install the PostToolUse inbox nudge hook (bridged to the hub). */
  nudgeHook: z.boolean(),
});
export type UnitSpec = z.infer<typeof UnitSpecSchema>;

export const TurnResultSchema = z.object({
  ok: z.boolean(),
  text: z.string(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
  interrupted: z.boolean().optional(),
  errors: z.array(z.string()).optional(),
  at: z.number(),
});

export const InitInfoSchema = z.object({
  sessionId: z.string(),
  model: z.string(),
  tools: z.array(z.string()),
  mcpServers: z.array(z.object({ name: z.string(), status: z.string() })),
  permissionMode: z.string().optional(),
});

/** One Runtime event, serialised. Mirrors RuntimeEvents in runtime/Runtime.ts. */
export const RuntimeEventSchema = z.discriminatedUnion("name", [
  z.object({ name: z.literal("status"), status: UnitStatusSchema, at: z.number() }),
  z.object({ name: z.literal("activity"), activity: z.string().optional() }),
  z.object({ name: z.literal("transcript"), entries: z.array(TranscriptEntrySchema) }),
  z.object({ name: z.literal("toolResult"), toolUseId: z.string(), ok: z.boolean(), at: z.number() }),
  z.object({ name: z.literal("permission"), request: PermissionRequestSchema.nullable() }),
  z.object({ name: z.literal("question"), question: PendingQuestionSchema.nullable() }),
  z.object({ name: z.literal("init"), info: InitInfoSchema }),
  z.object({ name: z.literal("result"), result: TurnResultSchema }),
  z.object({ name: z.literal("stopCapture"), text: z.string() }),
  z.object({ name: z.literal("notice"), text: z.string(), severity: z.enum(["info", "error"]) }),
  z.object({ name: z.literal("exit"), error: z.string().optional() }),
]);
export type RuntimeEvent = z.infer<typeof RuntimeEventSchema>;

/** Snapshot of one hosted unit, sent on attach so the hub can rebuild its projection. */
export const HostedUnitSchema = z.object({
  spec: UnitSpecSchema,
  status: UnitStatusSchema,
  sessionId: z.string().optional(),
  inFlight: z.boolean(),
  activity: z.string().optional(),
  pendingPermission: PermissionRequestSchema.optional(),
  pendingQuestion: PendingQuestionSchema.optional(),
  /** Events emitted while no hub was attached, oldest first. */
  buffered: z.array(RuntimeEventSchema),
  /** How many buffered events were dropped because the buffer overflowed. */
  dropped: z.number(),
});
export type HostedUnit = z.infer<typeof HostedUnitSchema>;

// ------------------------------------------------------------------ hub → host

export const HubRequestSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), id: z.string(), protocol: z.number(), hubVersion: z.string() }),
  z.object({ type: z.literal("start"), id: z.string(), spec: UnitSpecSchema }),
  z.object({ type: z.literal("stop"), id: z.string(), unitId: z.string() }),
  z.object({ type: z.literal("submit"), id: z.string(), unitId: z.string(), text: z.string(), source: OrderSourceSchema }),
  z.object({ type: z.literal("interrupt"), id: z.string(), unitId: z.string() }),
  z.object({
    type: z.literal("answerPermission"),
    id: z.string(),
    unitId: z.string(),
    answer: z.object({
      allow: z.boolean(),
      updatedInput: z.record(z.string(), z.unknown()).optional(),
      remember: z.boolean().optional(),
      message: z.string().optional(),
    }),
  }),
  z.object({ type: z.literal("answerQuestion"), id: z.string(), unitId: z.string(), answers: z.record(z.string(), z.string()) }),
  z.object({ type: z.literal("setModel"), id: z.string(), unitId: z.string(), model: z.string() }),
  z.object({ type: z.literal("setPermissionMode"), id: z.string(), unitId: z.string(), mode: PermissionModeSchema }),
  z.object({ type: z.literal("contextUsage"), id: z.string(), unitId: z.string() }),
  /** Reply to a bridge call the host made. */
  z.object({ type: z.literal("bridgeResult"), id: z.string(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }),
  /** Stop every unit and exit the host process. */
  z.object({ type: z.literal("shutdown"), id: z.string() }),
]);
export type HubRequest = z.infer<typeof HubRequestSchema>;

// ------------------------------------------------------------------ host → hub

export const HostMessageSchema = z.discriminatedUnion("type", [
  /** Answer to any hub request carrying `id`. `value` shape depends on the request. */
  z.object({ type: z.literal("reply"), id: z.string(), ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional() }),
  z.object({ type: z.literal("event"), unitId: z.string(), event: RuntimeEventSchema }),
  /** The host is shutting down and about to stop these units; the hub should recover them once a host is back. */
  z.object({ type: z.literal("closing"), units: z.array(z.string()) }),
  /**
   * A fleet tool call or hook fired inside a session and must be answered by the hub (the broker
   * lives there). `tool` → value is the MCP tool result; `nudge` → value is string | undefined.
   */
  z.object({
    type: z.literal("bridge"),
    id: z.string(),
    unitId: z.string(),
    kind: z.enum(["tool", "nudge"]),
    name: z.string(),
    args: z.record(z.string(), z.unknown()),
  }),
]);
export type HostMessage = z.infer<typeof HostMessageSchema>;

export const HelloReplySchema = z.object({
  protocol: z.number(),
  hostVersion: z.string(),
  pid: z.number(),
  startedAt: z.number(),
  units: z.array(HostedUnitSchema),
});
export type HelloReply = z.infer<typeof HelloReplySchema>;

/** Newline-delimited JSON framing shared by both ends. */
export function encodeFrame(msg: unknown): string {
  return JSON.stringify(msg) + "\n";
}

export class FrameParser {
  #buf = "";
  /** Feed raw socket data; returns every complete JSON value found. Malformed lines are skipped. */
  push(chunk: string, onBad?: (line: string) => void): unknown[] {
    this.#buf += chunk;
    const out: unknown[] = [];
    let nl: number;
    while ((nl = this.#buf.indexOf("\n")) >= 0) {
      const line = this.#buf.slice(0, nl);
      this.#buf = this.#buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        onBad?.(line);
      }
    }
    return out;
  }
}
