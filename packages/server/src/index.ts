import { loadEnv, loadFleetConfig } from "./config.js";
import { buildApp } from "./app.js";
import { VERSION } from "./version.js";

async function main() {
  const env = loadEnv();
  const fleet = loadFleetConfig(env.FLEET_CONFIG);
  const app = buildApp({ token: env.FLEET_TOKEN, logLevel: env.LOG_LEVEL, unitCount: () => fleet.units.length });
  await app.listen({ host: env.FLEET_HOST, port: env.FLEET_PORT });
  app.log.info(`Hex Command ${VERSION} listening on http://${env.FLEET_HOST}:${env.FLEET_PORT}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
