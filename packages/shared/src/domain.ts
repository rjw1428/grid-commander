import { z } from "zod";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

export const HexSchema = z.tuple([z.number().int(), z.number().int()]);
export type Hex = z.infer<typeof HexSchema>;

export const SlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "slug: lowercase letters, digits, - and _");

export const ColorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, "hex colour like #2d4a63");

export const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
  "dontAsk",
  "auto",
]);
export type PermissionMode = z.infer<typeof PermissionModeSchema>;

export const UnitStatusSchema = z.enum(["offline", "idle", "working", "waiting", "done", "error"]);
export type UnitStatus = z.infer<typeof UnitStatusSchema>;

export const CommsScopeSchema = z.enum(["project", "team", "fleet"]);
export type CommsScope = z.infer<typeof CommsScopeSchema>;

export const PrioritySchema = z.enum(["normal", "urgent"]);
export type Priority = z.infer<typeof PrioritySchema>;

// ---------------------------------------------------------------------------
// Project
// ---------------------------------------------------------------------------

export const ProjectDefaultsSchema = z.object({
  permissionMode: PermissionModeSchema.optional(),
  model: z.string().optional(),
  appendSystemPrompt: z.string().optional(),
});

export const ProjectSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(80),
  /** Absolute repo/worktree root. May be "" for the hq project (fleet root is used). */
  cwd: z.string(),
  tint: ColorSchema,
  flag: ColorSchema,
  cells: z.array(HexSchema),
  defaults: ProjectDefaultsSchema.optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

// ---------------------------------------------------------------------------
// Unit type
// ---------------------------------------------------------------------------

export const UnitTypeDefSchema = z.object({
  id: SlugSchema,
  name: z.string(),
  glyph: z.string().length(1),
  rank: z.string(),
  stars: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
  model: z.string(),
  color: ColorSchema,
  role: z.string(),
  systemPrompt: z.string(),
  rig: z.enum(["engineer", "infantry", "sniper", "officer"]),
  props: z.array(z.string()),
  workAnim: z.enum(["survey", "dig", "sweep", "paperwork", "radio", "bark"]),
  defaultPermissionMode: PermissionModeSchema,
  commsScope: CommsScopeSchema,
  /** May send `urgent` messages that interrupt a working recipient. */
  canInterrupt: z.boolean().default(false),
  /** Optional allow-list of fleet tools; all five when absent. */
  tools: z.array(z.string()).optional(),
});
export type UnitTypeDef = z.infer<typeof UnitTypeDefSchema>;

// ---------------------------------------------------------------------------
// Permission request / question (while status === "waiting")
// ---------------------------------------------------------------------------

export const PermissionRequestSchema = z.object({
  requestId: z.string(),
  toolName: z.string(),
  /** Summarised input (strings truncated); never the full file bodies. */
  input: z.record(z.string(), z.unknown()),
  summary: z.string(),
  /** Opaque SDK permission-update suggestions, echoed back on "always allow". */
  suggestions: z.array(z.unknown()).optional(),
  at: z.number(),
});
export type PermissionRequest = z.infer<typeof PermissionRequestSchema>;

export const QuestionOptionSchema = z.object({
  label: z.string(),
  description: z.string().optional(),
});
export const QuestionSchema = z.object({
  question: z.string(),
  header: z.string().optional(),
  options: z.array(QuestionOptionSchema),
  multiSelect: z.boolean().optional(),
});
export const PendingQuestionSchema = z.object({
  toolUseId: z.string(),
  questions: z.array(QuestionSchema),
  at: z.number(),
});
export type PendingQuestion = z.infer<typeof PendingQuestionSchema>;

// ---------------------------------------------------------------------------
// Unit
// ---------------------------------------------------------------------------

export const LastResultSchema = z.object({
  at: z.number(),
  text: z.string(),
  ok: z.boolean().optional(),
  costUsd: z.number().optional(),
  durationMs: z.number().optional(),
});

export const UnitSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(40),
  type: z.string(),
  projectId: z.string(),
  teamId: z.string().optional(),
  hex: HexSchema,
  task: z.string().max(200),
  status: UnitStatusSchema,
  statusSince: z.number(),
  activity: z.string().optional(),
  sessionId: z.string().optional(),
  model: z.string(),
  permissionMode: PermissionModeSchema,
  queueLength: z.number().int().nonnegative(),
  unreadInbox: z.number().int().nonnegative(),
  pendingPermission: PermissionRequestSchema.optional(),
  pendingQuestion: PendingQuestionSchema.optional(),
  lastResult: LastResultSchema.optional(),
  /** Set by fleet_report({ done: true }); shows a flag on the map. */
  missionDone: z.boolean().optional(),
  autostart: z.boolean().optional(),
  createdAt: z.number(),
});
export type Unit = z.infer<typeof UnitSchema>;

// ---------------------------------------------------------------------------
// Team
// ---------------------------------------------------------------------------

export const TeamSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(60),
  color: ColorSchema,
  memberIds: z.array(z.string()),
  createdAt: z.number(),
});
export type Team = z.infer<typeof TeamSchema>;

// ---------------------------------------------------------------------------
// Order
// ---------------------------------------------------------------------------

export const OrderSourceSchema = z.enum(["operator", "broadcast", "queue", "inbox", "urgent"]);
export type OrderSource = z.infer<typeof OrderSourceSchema>;

export const OrderSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  text: z.string(),
  source: OrderSourceSchema,
  createdAt: z.number(),
  submittedAt: z.number().optional(),
  turnId: z.string().optional(),
});
export type Order = z.infer<typeof OrderSchema>;

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

export const MessageTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unit"), id: z.string() }),
  z.object({ kind: z.literal("team"), id: z.string() }),
  z.object({ kind: z.literal("project"), id: z.string() }),
  z.object({ kind: z.literal("fleet") }),
]);
export type MessageTarget = z.infer<typeof MessageTargetSchema>;

export const DeliveryHowSchema = z.enum(["turn", "interrupt", "tool"]);
export const DeliverySchema = z.object({
  deliveredAt: z.number().optional(),
  readAt: z.number().optional(),
  how: DeliveryHowSchema.optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const MessageSchema = z.object({
  id: z.string(),
  /** unit id or "operator" */
  from: z.string(),
  to: MessageTargetSchema,
  body: z.string(),
  priority: PrioritySchema,
  threadId: z.string(),
  replyTo: z.string().optional(),
  createdAt: z.number(),
  /** per recipient unit id */
  deliveries: z.record(z.string(), DeliverySchema),
  /** Relay output: shown as from the source unit with a suffix. */
  relayedFrom: z.string().optional(),
});
export type Message = z.infer<typeof MessageSchema>;

// ---------------------------------------------------------------------------
// Alert
// ---------------------------------------------------------------------------

export const AlertKindSchema = z.enum(["waiting", "error", "done", "idle", "message", "info"]);
export type AlertKind = z.infer<typeof AlertKindSchema>;

export const AlertSchema = z.object({
  id: z.string(),
  kind: AlertKindSchema,
  unitId: z.string().optional(),
  title: z.string(),
  body: z.string(),
  createdAt: z.number(),
  dismissedAt: z.number().optional(),
  payload: z.unknown().optional(),
});
export type Alert = z.infer<typeof AlertSchema>;

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export const TranscriptEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("user"), at: z.number(), text: z.string(), source: OrderSourceSchema }),
  z.object({ kind: z.literal("assistant"), at: z.number(), text: z.string() }),
  z.object({
    kind: z.literal("tool"),
    at: z.number(),
    name: z.string(),
    summary: z.string(),
    toolUseId: z.string().optional(),
    ok: z.boolean().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("result"),
    at: z.number(),
    ok: z.boolean(),
    text: z.string(),
    costUsd: z.number().optional(),
    durationMs: z.number().optional(),
  }),
  z.object({
    kind: z.literal("message"),
    at: z.number(),
    messageId: z.string(),
    direction: z.enum(["in", "out"]),
    text: z.string().optional(),
  }),
  z.object({ kind: z.literal("system"), at: z.number(), text: z.string() }),
]);
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// ---------------------------------------------------------------------------
// fleet.json
// ---------------------------------------------------------------------------

export const FleetUnitConfigSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(40),
  type: z.string(),
  projectId: z.string(),
  teamId: z.string().optional(),
  hex: HexSchema.optional(),
  task: z.string().max(200).default(""),
  model: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  autostart: z.boolean().default(false),
});
export type FleetUnitConfig = z.infer<typeof FleetUnitConfigSchema>;

export const FleetTeamConfigSchema = z.object({
  id: SlugSchema,
  name: z.string().min(1).max(60),
  color: ColorSchema,
  memberIds: z.array(z.string()).default([]),
});

export const FleetConfigSchema = z.object({
  projects: z.array(ProjectSchema).default([]),
  teams: z.array(FleetTeamConfigSchema).default([]),
  units: z.array(FleetUnitConfigSchema).default([]),
  settings: z.record(z.string(), z.unknown()).optional(),
});
export type FleetConfig = z.infer<typeof FleetConfigSchema>;

// ---------------------------------------------------------------------------
// Settings (server `settings` table, exposed in snapshot)
// ---------------------------------------------------------------------------

export const SettingsSchema = z.object({
  "comms.crossProject": z.boolean().default(false),
  "push.kinds": z.array(AlertKindSchema).default(["waiting", "error", "done"]),
  "alerts.idleMs": z.number().int().positive().default(120_000),
  "alerts.doneAutoAckMs": z.number().int().positive().default(600_000),
});
export type Settings = z.infer<typeof SettingsSchema>;

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const ServerInfoSchema = z.object({
  version: z.string(),
  uptime: z.number(),
  runningUnits: z.number().int(),
  maxUnits: z.number().int(),
  pushEnabled: z.boolean(),
  hasHq: z.boolean(),
});
export type ServerInfo = z.infer<typeof ServerInfoSchema>;

export const SnapshotSchema = z.object({
  projects: z.array(ProjectSchema),
  teams: z.array(TeamSchema),
  units: z.array(UnitSchema),
  alerts: z.array(AlertSchema),
  unitTypes: z.array(UnitTypeDefSchema),
  settings: SettingsSchema,
  server: ServerInfoSchema,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;
