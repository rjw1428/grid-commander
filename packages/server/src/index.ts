import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pino from "pino";
import { loadEnv, loadFleetConfig, type Env } from "./config.js";
import { buildApp } from "./app.js";
import { createHub, type HubHostOptions } from "./hub.js";
import { createWebPushSender } from "./alerts/PushService.js";
import { VERSION } from "./version.js";

const here = dirname(fileURLToPath(import.meta.url));

/** Without FLEET_TOKEN, keep a generated token next to the database so `pnpm start` needs no ceremony. */
function loadOrCreateToken(file: string, log: pino.Logger): string {
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t.length >= 8) {
      log.info({ tokenFile: file }, "FLEET_TOKEN not set; using the token file");
      return t;
    }
  }
  mkdirSync(dirname(file), { recursive: true });
  const t = randomBytes(24).toString("hex");
  writeFileSync(file, t + "\n", { mode: 0o600 });
  log.info({ tokenFile: file }, "FLEET_TOKEN not set; generated a token file. Open /?token=$(cat <tokenFile>)");
  return t;
}

/**
 * The unit host is launched with the same node binary and loader flags as this process (plain node
 * for `pnpm start`, the tsx loader for `pnpm dev`), detached, logging to `<data dir>/host.log`.
 */
function hostOptions(env: Env, dataDir: string): HubHostOptions {
  mkdirSync(dataDir, { recursive: true });
  const ts = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(ts ? "./host/index.ts" : "./host/index.js", import.meta.url));
  let socketPath = env.FLEET_HOST_SOCKET ? resolve(process.env.INIT_CWD ?? process.cwd(), env.FLEET_HOST_SOCKET) : join(dataDir, "host.sock");
  if (!env.FLEET_HOST_SOCKET && Buffer.byteLength(socketPath) > 100) {
    // Unix socket paths are capped around 104 bytes on macOS; deep data dirs fall back to the temp dir
    socketPath = join(tmpdir(), `gridcommander-${createHash("sha1").update(dataDir).digest("hex").slice(0, 12)}.sock`);
  }
  const pidFile = join(dataDir, "host.pid");
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FLEET_HOST_SOCKET: socketPath,
    FLEET_HOST_PID: pidFile,
    LOG_LEVEL: env.LOG_LEVEL,
    ...(env.FLEET_DEMO ? { FLEET_DEMO: env.FLEET_DEMO } : {}),
    ...(env.FLEET_HOST_IDLE_EXIT_MS !== undefined ? { FLEET_HOST_IDLE_EXIT_MS: String(env.FLEET_HOST_IDLE_EXIT_MS) } : {}),
  };
  return {
    socketPath,
    spawn: {
      command: process.execPath,
      args: [...process.execArgv.filter((a) => !a.startsWith("--inspect")), entry],
      env: childEnv,
      cwd: resolve(here, ".."), // packages/server, same as `pnpm start`
      logFile: join(dataDir, "host.log"),
      pidFile,
    },
  };
}

async function main() {
  const env = loadEnv();
  const log = pino({ level: env.LOG_LEVEL, redact: ["*.token", "*.authorization"] });
  // pnpm runs the script with cwd = packages/server; resolve relative paths against the invoking directory.
  const base = process.env.INIT_CWD ?? process.cwd();
  const configPath = resolve(base, env.FLEET_CONFIG);
  const inMemory = env.FLEET_DB === ":memory:";
  const dbPath = inMemory ? env.FLEET_DB : resolve(base, env.FLEET_DB);
  const fleetRoot = env.FLEET_ROOT ? resolve(base, env.FLEET_ROOT) : base;
  if (!existsSync(configPath)) log.warn({ configPath }, "fleet config not found; starting with an empty fleet");
  const fleet = loadFleetConfig(configPath);
  const dataDir = inMemory ? resolve(base, "data") : dirname(dbPath);
  const token = env.FLEET_TOKEN ?? loadOrCreateToken(join(dataDir, "token"), log);
  const host = env.FLEET_INPROC === "1" ? undefined : hostOptions(env, dataDir);
  const browseRoots = env.FLEET_BROWSE_ROOTS
    ? env.FLEET_BROWSE_ROOTS.split(",").map((p) => resolve(base, p.trim())).filter(Boolean)
    : [...new Set([homedir(), fleetRoot])];

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
    host,
    pushSender,
  });
  if (pushSender) log.info("web push enabled");
  if (host) log.info({ socket: host.socketPath }, "sessions run in the unit host; this process can restart without stopping them");
  else log.warn("FLEET_INPROC=1: sessions run in this process and stop when it stops");
  if (env.FLEET_DEMO === "1") log.warn("FLEET_DEMO=1: units run a scripted demo runtime, not Claude");
  await hub.boot(fleet);

  const clientDist = env.CLIENT_DIST ? resolve(env.CLIENT_DIST) : resolve(here, "../../client/dist");
  const app = await buildApp({
    token,
    browseRoots,
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
