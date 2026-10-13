import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { FleetConfigSchema, type FleetConfig } from "@hexcommand/shared";

const EnvSchema = z.object({
  FLEET_TOKEN: z.string().min(8, "FLEET_TOKEN must be at least 8 characters"),
  FLEET_HOST: z.string().default("127.0.0.1"),
  FLEET_PORT: z.coerce.number().int().positive().default(7777),
  FLEET_CONFIG: z.string().default("./fleet.json"),
  FLEET_DB: z.string().default("./data/fleet.db"),
  FLEET_IDLE_ALERT_MS: z.coerce.number().int().positive().default(120_000),
  FLEET_DONE_AUTOACK_MS: z.coerce.number().int().positive().default(600_000),
  FLEET_MAX_UNITS: z.coerce.number().int().positive().default(24),
  FLEET_PERMISSION_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  FLEET_ROOT: z.string().optional(),
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  FLEET_E2E: z.string().optional(),
  /** 1 = scripted demo runtime instead of the Agent SDK (no Claude needed). */
  FLEET_DEMO: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
  CLIENT_DIST: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid environment: ${issues}`);
  }
  return parsed.data;
}

export function loadFleetConfig(path: string): FleetConfig {
  const abs = resolve(path);
  if (!existsSync(abs)) {
    return FleetConfigSchema.parse({ projects: [], teams: [], units: [] });
  }
  const raw = JSON.parse(readFileSync(abs, "utf8"));
  const parsed = FleetConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`invalid fleet config ${abs}: ${issues}`);
  }
  return parsed.data;
}
