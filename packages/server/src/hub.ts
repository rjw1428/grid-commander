import { getUnitType, UNIT_TYPES, type FleetConfig, type Settings, type Snapshot } from "@hexcommand/shared";
import { AlertEngine } from "./alerts/AlertEngine.js";
import { Bus } from "./bus.js";
import { FleetService } from "./fleet/FleetService.js";
import { OrderService } from "./fleet/OrderService.js";
import { UnitService, type RuntimeFactory } from "./fleet/UnitService.js";
import { buildUnitSystemPrompt } from "./runtime/systemPrompt.js";
import { UnitRuntime, realSdk, type RuntimeLogger, type SdkFacade } from "./runtime/UnitRuntime.js";
import { DemoRuntime } from "./runtime/DemoRuntime.js";
import { CommsBroker } from "./comms/CommsBroker.js";
import { FLEET_TOOL_NAMES, fleetServerForUnit } from "./comms/fleetTools.js";
import { hooksForUnit } from "./comms/hooks.js";
import { openDb, type Db } from "./store/db.js";
import { createStores, type Stores } from "./store/stores.js";
import { VERSION } from "./version.js";

export interface HubOptions {
  dbPath: string;
  configPath?: string;
  fleetRoot: string;
  maxUnits: number;
  doneAutoAckMs: number;
  idleAlertMs?: number;
  log: RuntimeLogger;
  /** Override the runtime factory (tests inject the fake SDK). */
  factory?: RuntimeFactory;
  /** Scripted demo runtime instead of the SDK. */
  demo?: boolean;
  sdk?: SdkFacade;
  transcriptBatchMs?: number;
  watchdogMs?: number;
  autoStartOnOrder?: boolean;
  pushEnabled?: boolean;
  nudgeIntervalMs?: number;
}

export interface Hub {
  db: Db;
  stores: Stores;
  bus: Bus;
  fleet: FleetService;
  units: UnitService;
  orders: OrderService;
  alerts: AlertEngine;
  comms: CommsBroker;
  settings(): Settings;
  patchSettings(p: Partial<Settings>): Settings;
  snapshot(): Snapshot;
  /** Load fleet.json + DB, report units that were mid-turn, start autostart units. */
  boot(cfg: FleetConfig, opts?: { autostart?: boolean }): Promise<void>;
  shutdown(): Promise<void>;
  readonly startedAt: number;
  readonly pushEnabled: boolean;
}

/** Production runtime factory: real SDK, preset system prompt + unit briefing. M5 adds MCP tools/hooks. */
export function defaultRuntimeFactory(sdk: SdkFacade, log: RuntimeLogger): RuntimeFactory {
  return ({ unit, type, project, cwd, getUnit, comms }) =>
    new UnitRuntime(
      {
        unitId: unit.id,
        cwd,
        model: unit.model,
        permissionMode: unit.permissionMode,
        sessionId: unit.sessionId,
        systemPromptAppend: buildUnitSystemPrompt(unit, type, project),
        ...(comms ? { mcpServers: (s) => ({ fleet: fleetServerForUnit(s, unit.id, getUnit, comms) }), hooks: hooksForUnit(unit.id, comms), allowedTools: FLEET_TOOL_NAMES.map((n) => `mcp__fleet__${n}`) } : {}),
        log,
        ...(process.env.ANTHROPIC_API_KEY ? { env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } } : {}),
      },
      sdk,
    );
}

export function demoRuntimeFactory(speed = 1): RuntimeFactory {
  return ({ unit }) => new DemoRuntime({ unitId: unit.id, name: unit.name, model: unit.model, permissionMode: unit.permissionMode, sessionId: unit.sessionId, speed });
}

export function createHub(opts: HubOptions): Hub {
  const db = openDb(opts.dbPath);
  const stores = createStores(db);
  const bus = new Bus((err, ev) => opts.log.error({ err, ev }, "bus listener threw"));
  const fleet = new FleetService({ stores, bus, configPath: opts.configPath, log: opts.log, fleetRoot: opts.fleetRoot });
  const factory = opts.factory ?? (opts.demo ? demoRuntimeFactory() : defaultRuntimeFactory(opts.sdk ?? realSdk, opts.log));
  const commsRef: { current?: CommsBroker } = {};
  const units = new UnitService({
    fleet,
    stores,
    bus,
    factory,
    maxUnits: opts.maxUnits,
    doneAutoAckMs: opts.doneAutoAckMs,
    log: opts.log,
    transcriptBatchMs: opts.transcriptBatchMs,
    getComms: () => commsRef.current,
  });
  const orders = new OrderService({ stores, fleet, units, bus, log: opts.log, autoStartOnOrder: opts.autoStartOnOrder });
  let settingsCache = stores.settings.all();
  if (opts.idleAlertMs && settingsCache["alerts.idleMs"] === 120_000) settingsCache = { ...settingsCache, "alerts.idleMs": opts.idleAlertMs };
  const alerts = new AlertEngine({ stores, bus, fleet, units, settings: () => settingsCache, log: opts.log, watchdogMs: opts.watchdogMs });
  const comms = new CommsBroker({ stores, fleet, units, orders, alerts, bus, settings: () => settingsCache, log: opts.log, nudgeIntervalMs: opts.nudgeIntervalMs });
  commsRef.current = comms;
  const startedAt = Date.now();
  const publishInfo = () => bus.publish({ type: "server.info", info: hub.snapshot().server });
  units.on("started", publishInfo);
  units.on("stopped", publishInfo);

  const hub: Hub = {
    db,
    stores,
    bus,
    fleet,
    units,
    orders,
    alerts,
    comms,
    startedAt,
    pushEnabled: opts.pushEnabled ?? false,
    settings: () => settingsCache,
    patchSettings(p) {
      settingsCache = stores.settings.set(p);
      bus.publish({ type: "settings.upsert", settings: settingsCache });
      return settingsCache;
    },
    snapshot(): Snapshot {
      return {
        projects: [...fleet.projects.values()],
        teams: [...fleet.teams.values()],
        units: [...fleet.units.values()],
        alerts: alerts.list(),
        unitTypes: [...UNIT_TYPES],
        settings: settingsCache,
        server: {
          version: VERSION,
          uptime: Date.now() - startedAt,
          runningUnits: units.runningCount,
          maxUnits: opts.maxUnits,
          pushEnabled: hub.pushEnabled,
          hasHq: fleet.hasHq(),
        },
      };
    },
    async boot(cfg, bootOpts = {}) {
      for (const t of UNIT_TYPES) getUnitType(t.id); // validates unit-types.json at startup
      const { wasWorking } = fleet.load(cfg);
      alerts.start();
      for (const u of wasWorking) {
        alerts.raise({ kind: "info", unitId: u.id, title: u.name, body: "was mid-turn when the server stopped; resume with Start" });
      }
      if (bootOpts.autostart !== false) {
        for (const u of fleet.units.values()) {
          if (!u.autostart) continue;
          try {
            await units.start(u.id);
          } catch (err) {
            opts.log.warn({ err, unitId: u.id }, "autostart failed");
          }
        }
      }
    },
    async shutdown() {
      alerts.stop();
      await units.shutdown();
      fleet.flush();
      db.close();
    },
  };
  return hub;
}
