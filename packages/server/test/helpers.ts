import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FleetConfigSchema, type FleetConfig } from "@hexcommand/shared";
import { buildApp } from "../src/app.js";
import { createHub, type Hub, type HubOptions } from "../src/hub.js";
import { UnitRuntime } from "../src/runtime/UnitRuntime.js";
import { createFakeSdk, scripts, type FakeSdkOptions, type FakeTurnScript } from "./fakeSdk.js";

const here = dirname(fileURLToPath(import.meta.url));
export const TOKEN = "test-token-0123456789";

export const silentLog = { debug() {}, info() {}, warn() {}, error() {} };

export function exampleFleet(): FleetConfig {
  return FleetConfigSchema.parse(JSON.parse(readFileSync(join(here, "../../../fleet.example.json"), "utf8")));
}

export interface TestHub {
  hub: Hub;
  sdk: ReturnType<typeof createFakeSdk>;
}

export function createTestHub(
  opts: { turns?: FakeTurnScript[]; sdkOptions?: Partial<FakeSdkOptions>; hub?: Partial<HubOptions>; configPath?: string } = {},
): TestHub {
  const sdk = createFakeSdk({ turns: opts.turns ?? [scripts.happy()], ...opts.sdkOptions });
  const hub = createHub({
    dbPath: ":memory:",
    configPath: opts.configPath,
    fleetRoot: process.cwd(),
    maxUnits: 24,
    doneAutoAckMs: 0,
    log: silentLog,
    transcriptBatchMs: 0,
    watchdogMs: 60 * 60 * 1000,
    factory: ({ unit, cwd }) =>
      new UnitRuntime(
        {
          unitId: unit.id,
          cwd,
          model: unit.model,
          permissionMode: unit.permissionMode,
          sessionId: unit.sessionId,
          systemPromptAppend: "",
          startGraceMs: 10,
          interruptTimeoutMs: 1000,
        },
        sdk,
      ),
    ...opts.hub,
  });
  return { hub, sdk };
}

export async function createTestApp(t: TestHub) {
  const app = await buildApp({ token: TOKEN, logLevel: "silent", hub: t.hub });
  const auth = { authorization: `Bearer ${TOKEN}` };
  const req = async (method: "GET" | "POST" | "PATCH" | "DELETE", url: string, body?: unknown) => {
    const res = await app.inject({ method, url: `/api${url}`, headers: auth, ...(body !== undefined ? { payload: body } : {}) });
    let json: unknown = null;
    try {
      json = res.body ? res.json() : null;
    } catch {
      json = res.body;
    }
    return { status: res.statusCode, json: json as any };
  };
  return { app, req, auth };
}

export const until = async (pred: () => boolean, ms = 3000, label = "condition") => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 5));
  }
};
