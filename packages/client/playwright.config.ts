import { defineConfig } from "@playwright/test";

const PORT = 7798;
export const TOKEN = "playwright-token-0123456789";

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  retries: 0,
  use: { baseURL: `http://127.0.0.1:${PORT}`, viewport: { width: 1400, height: 900 } },
  webServer: {
    command: `node ../server/dist/index.js`,
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    env: {
      FLEET_TOKEN: TOKEN,
      FLEET_PORT: String(PORT),
      FLEET_CONFIG: "../../fleet.example.json",
      FLEET_DB: ":memory:",
      LOG_LEVEL: "warn",
      CLIENT_DIST: "./dist",
    },
    timeout: 30_000,
  },
});
