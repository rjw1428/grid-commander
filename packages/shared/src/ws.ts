import { z } from "zod";
import {
  AlertSchema,
  MessageSchema,
  PermissionRequestSchema,
  PendingQuestionSchema,
  ProjectSchema,
  ServerInfoSchema,
  SnapshotSchema,
  TeamSchema,
  TranscriptEntrySchema,
  UnitSchema,
} from "./domain.js";

/** Server → client events. */
export const WsServerEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("snapshot"), state: SnapshotSchema }),
  z.object({ type: z.literal("unit.upsert"), unit: UnitSchema }),
  z.object({ type: z.literal("unit.remove"), id: z.string() }),
  z.object({
    type: z.literal("unit.transcript"),
    unitId: z.string(),
    entries: z.array(TranscriptEntrySchema),
  }),
  z.object({
    type: z.literal("unit.permission"),
    unitId: z.string(),
    request: PermissionRequestSchema.nullable(),
  }),
  z.object({
    type: z.literal("unit.question"),
    unitId: z.string(),
    question: PendingQuestionSchema.nullable(),
  }),
  z.object({ type: z.literal("alert.upsert"), alert: AlertSchema }),
  z.object({ type: z.literal("alert.remove"), id: z.string() }),
  z.object({ type: z.literal("message.new"), message: MessageSchema }),
  z.object({ type: z.literal("project.upsert"), project: ProjectSchema }),
  z.object({ type: z.literal("project.remove"), id: z.string() }),
  z.object({ type: z.literal("team.upsert"), team: TeamSchema }),
  z.object({ type: z.literal("team.remove"), id: z.string() }),
  z.object({ type: z.literal("settings.upsert"), settings: z.record(z.string(), z.unknown()) }),
  z.object({ type: z.literal("server.info"), info: ServerInfoSchema }),
  z.object({ type: z.literal("pong") }),
]);
export type WsServerEvent = z.infer<typeof WsServerEventSchema>;

/** Client → server. Commands go through REST; the socket only pings. */
export const WsClientEventSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("ping") }),
]);
export type WsClientEvent = z.infer<typeof WsClientEventSchema>;
