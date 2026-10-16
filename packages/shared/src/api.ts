import { z } from "zod";
import {
  AlertKindSchema,
  ColorSchema,
  HexSchema,
  MessageTargetSchema,
  PermissionModeSchema,
  PrioritySchema,
  ProjectDefaultsSchema,
  SlugSchema,
} from "./domain.js";

export const ApiErrorSchema = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

// Units -----------------------------------------------------------------------

export const CreateUnitBodySchema = z.object({
  id: SlugSchema.optional(),
  name: z.string().min(1).max(40),
  type: z.string(),
  projectId: z.string(),
  hex: HexSchema.optional(),
  task: z.string().max(200).optional(),
  model: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  teamId: z.string().optional(),
  firstOrder: z.string().optional(),
  start: z.boolean().optional(),
});
export type CreateUnitBody = z.infer<typeof CreateUnitBodySchema>;

export const PatchUnitBodySchema = z.object({
  name: z.string().min(1).max(40).optional(),
  task: z.string().max(200).optional(),
  hex: HexSchema.optional(),
  projectId: z.string().optional(),
  teamId: z.string().nullable().optional(),
  model: z.string().optional(),
  permissionMode: PermissionModeSchema.optional(),
  autostart: z.boolean().optional(),
});
export type PatchUnitBody = z.infer<typeof PatchUnitBodySchema>;

export const OrderBodySchema = z.object({
  text: z.string().min(1).max(100_000),
  interrupt: z.boolean().optional(),
});
export type OrderBody = z.infer<typeof OrderBodySchema>;

export const OrderResponseSchema = z.object({ orderId: z.string(), queued: z.boolean() });
export type OrderResponse = z.infer<typeof OrderResponseSchema>;

export const PermissionAnswerBodySchema = z.object({
  allow: z.boolean(),
  updatedInput: z.record(z.string(), z.unknown()).optional(),
  remember: z.boolean().optional(),
  message: z.string().optional(),
});
export type PermissionAnswerBody = z.infer<typeof PermissionAnswerBodySchema>;

export const QuestionAnswerBodySchema = z.object({
  answers: z.record(z.string(), z.string()),
});
export type QuestionAnswerBody = z.infer<typeof QuestionAnswerBodySchema>;

export const TranscriptQuerySchema = z.object({
  before: z.coerce.number().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

// Broadcast / messages -----------------------------------------------------------

export const BroadcastTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fleet") }),
  z.object({ kind: z.literal("team"), id: z.string() }),
  z.object({ kind: z.literal("project"), id: z.string() }),
  z.object({ kind: z.literal("units"), ids: z.array(z.string()).min(1) }),
]);
export type BroadcastTarget = z.infer<typeof BroadcastTargetSchema>;

export const BroadcastBodySchema = z.object({
  to: BroadcastTargetSchema,
  text: z.string().min(1).max(100_000),
  queueIfBusy: z.boolean().default(true),
});
export type BroadcastBody = z.infer<typeof BroadcastBodySchema>;

export const BroadcastResponseSchema = z.object({
  sent: z.array(z.string()),
  queued: z.array(z.string()),
  skipped: z.array(z.string()),
});

export const OperatorMessageBodySchema = z.object({
  to: MessageTargetSchema,
  body: z.string().min(1).max(20_000),
  priority: PrioritySchema.default("normal"),
  replyTo: z.string().optional(),
  /** Relay output: the unit whose lastResult this message carries. */
  relayedFrom: z.string().optional(),
});
export type OperatorMessageBody = z.infer<typeof OperatorMessageBodySchema>;

export const MessagesQuerySchema = z.object({
  threadId: z.string().optional(),
  unitId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

// Projects / teams -----------------------------------------------------------------

export const CreateProjectBodySchema = z.object({
  id: SlugSchema.optional(),
  name: z.string().min(1).max(80),
  cwd: z.string(),
  tint: ColorSchema.optional(),
  flag: ColorSchema.optional(),
  cells: z.array(HexSchema).optional(),
  /** Auto-allocated territory size when `cells` is omitted: 7 (radius 1), 19 (radius 2) or 37 (radius 3). */
  size: z.union([z.literal(7), z.literal(19), z.literal(37)]).optional(),
  defaults: ProjectDefaultsSchema.optional(),
});
export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const PatchProjectBodySchema = CreateProjectBodySchema.omit({ id: true, size: true }).partial();
export type PatchProjectBody = z.infer<typeof PatchProjectBodySchema>;

export const CreateTeamBodySchema = z.object({
  id: SlugSchema.optional(),
  name: z.string().min(1).max(60),
  color: ColorSchema.optional(),
  memberIds: z.array(z.string()).default([]),
});
export type CreateTeamBody = z.infer<typeof CreateTeamBodySchema>;

export const PatchTeamBodySchema = CreateTeamBodySchema.omit({ id: true }).partial();
export type PatchTeamBody = z.infer<typeof PatchTeamBodySchema>;

// Settings / push --------------------------------------------------------------------

export const PatchSettingsBodySchema = z.object({
  "comms.crossProject": z.boolean().optional(),
  "push.kinds": z.array(AlertKindSchema).optional(),
  "alerts.idleMs": z.number().int().positive().optional(),
  "alerts.doneAutoAckMs": z.number().int().positive().optional(),
});
export type PatchSettingsBody = z.infer<typeof PatchSettingsBodySchema>;

export const PushSubscriptionBodySchema = z.object({
  endpoint: z.string().url(),
  expirationTime: z.number().nullable().optional(),
  keys: z.object({ p256dh: z.string(), auth: z.string() }),
});
export type PushSubscriptionBody = z.infer<typeof PushSubscriptionBodySchema>;

export const HealthSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  units: z.number().int(),
});
export type Health = z.infer<typeof HealthSchema>;

// ----------------------------------------------------------------------------- directory browser

export const DirEntrySchema = z.object({
  name: z.string(),
  path: z.string(),
  /** directory contains a .git folder */
  git: z.boolean(),
});
export type DirEntry = z.infer<typeof DirEntrySchema>;

export const DirListingSchema = z.object({
  path: z.string(),
  name: z.string(),
  /** null at a browsable root */
  parent: z.string().nullable(),
  roots: z.array(z.string()),
  git: z.boolean(),
  entries: z.array(DirEntrySchema),
});
export type DirListing = z.infer<typeof DirListingSchema>;

export const DirQuerySchema = z.object({
  path: z.string().optional(),
  hidden: z.enum(["0", "1"]).optional(),
});
