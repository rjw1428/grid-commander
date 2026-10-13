import { defineConfig } from "@playwright/test";

const PORT = 7798;
export const TOKEN = "playwright-token-0123456789";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1400, height: 900 } },
  webServer: {
    // fresh copy of the example fleet per run: the server writes back to FLEET_CONFIG
    command: `mkdir -p test-results && cp ../../fleet.example.json test-results/fleet.json && node ../server/dist/index.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      FLEET_TOKEN: TOKEN,
      FLEET_PORT: String(PORT),
      FLEET_CONFIG: "./test-results/fleet.json",
      FLEET_DB: ":memory:",
      LOG_LEVEL: "warn",
      CLIENT_DIST: "./dist",
      FLEET_DEMO: "1",
    },
    timeout: 30_000,
  },
});
