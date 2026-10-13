import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadEnv, loadFleetConfig } from "./config.js";
import { buildApp } from "./app.js";
import { createHub } from "./hub.js";
import { createWebPushSender } from "./alerts/PushService.js";
import { VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));

async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, redact: ["*.token", "*.authorization"] });
  // pnpm runs the script with cwd = packages/server; resolve relative paths against the invoking directory.
  const base = process.env.INIT_CWD ?? process.cwd();
  const configPath = resolve(base, env.FLEET_CONFIG);
  const dbPath = resolve(base, env.FLEET_DB);
  const fleetRoot = env.FLEET_ROOT ? resolve(base, env.FLEET_ROOT) : base;
  if (!existsSync(configPath)) log.warn({ configPath }, "fleet config not found; starting with an empty fleet");
  const fleet = loadFleetConfig(configPath);

  const pushSender =
    env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY
      ? await createWebPushSender({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT ?? "mailto:operator@gridcommander.local" })
      : undefined;
  const hub = createHub({
    dbPath,
    configPath,
    fleetRoot,
    maxUnits: env.FLEET_MAX_UNITS,
    doneAutoAckMs: env.FLEET_DONE_AUTOACK_MS,
    idleAlertMs: env.FLEET_IDLE_ALERT_MS,
    log,
    pushEnabled: Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY),
    demo: env.FLEET_DEMO === "1",
    pushSender,
  });
  if (pushSender) log.info("web push enabled");
  if (env.FLEET_DEMO === "1") log.warn("FLEET_DEMO=1: units run a scripted demo runtime, not Claude");
  await hub.boot(fleet);

  const clientDist = env.CLIENT_DIST ? resolve(env.CLIENT_DIST) : resolve(here, "../../client/dist");
  const app = await buildApp({
    token: env.FLEET_TOKEN,
    logLevel: env.LOG_LEVEL,
    hub,
    clientDist,
    push: { vapidPublicKey: env.VAPID_PUBLIC_KEY },
  });

  const shutdown = async (signal: string) => {
    log.info({ signal }, "shutting down");
    try {
      await app.close();
      await hub.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await app.listen({ host: env.FLEET_HOST, port: env.FLEET_PORT });
  log.info(
    { version: VERSION, units: hub.fleet.units.size, running: hub.units.runningCount, client: clientDist },
    `Grid Commander listening on http://${env.FLEET_HOST}:${env.FLEET_PORT}`,
  );
  void join;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
