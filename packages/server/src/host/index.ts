/**
 * Unit host entry point. Launched detached by the hub (see HostClient) or by hand:
 *   FLEET_HOST_SOCKET=./data/host.sock node dist/host/index.js
 * Owns the Claude sessions so the web server can restart freely. Stops every unit on SIGTERM.
 */
import { existsSync, unlinkSync, writeFileSync } from "node:fs";
import pino from "pino";
import { z } from "zod";
import { VERSION } from "../version.js";
import { demoHostFactory, sdkHostFactory } from "./factories.js";
import { HostServer } from "./HostServer.js";

const EnvSchema = z.object({
  FLEET_HOST_SOCKET: z.string().min(1),
  FLEET_HOST_PID: z.string().optional(),
  FLEET_HOST_IDLE_EXIT_MS: z.coerce.number().int().nonnegative().default(10 * 60_000),
  FLEET_DEMO: z.string().optional(),
  LOG_LEVEL: z.string().default("info"),
});

async function main() {
  const env = EnvSchema.parse(process.env);
  const log = pino({ level: env.LOG_LEVEL, redact: ["*.token", "*.authorization"] });
  const demo = env.FLEET_DEMO === "1";

  const cleanupPid = () => {
    if (env.FLEET_HOST_PID && existsSync(env.FLEET_HOST_PID)) {
      try {
        unlinkSync(env.FLEET_HOST_PID);
      } catch {
        /* ignore */
      }
    }
  };
  const exit = (code: number) => {
    cleanupPid();
    process.exit(code);
  };

  const host = new HostServer({
    socketPath: env.FLEET_HOST_SOCKET,
    factory: demo ? demoHostFactory() : sdkHostFactory(log),
    log,
    version: VERSION,
    idleExitMs: env.FLEET_HOST_IDLE_EXIT_MS,
    onIdleExit: () => void shutdown("idle"),
    onShutdown: () => exit(0),
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal, units: host.unitIds.length }, "unit host shutting down");
    try {
      await host.close();
    } finally {
      exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGHUP", () => {
    /* the terminal that ran `pnpm dev` may close; units keep running */
  });

  await host.listen();
  if (env.FLEET_HOST_PID) writeFileSync(env.FLEET_HOST_PID, `${process.pid}\n`);
  if (demo) log.warn("FLEET_DEMO=1: hosting scripted demo units, not Claude");
  log.info({ version: VERSION, pid: process.pid }, "Grid Commander unit host ready");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
