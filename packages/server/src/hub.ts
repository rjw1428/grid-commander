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
import { PushService, type PushSender } from "./alerts/PushService.js";
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
  /** Context-usage check interval; 0 disables. */
  contextCheckMs?: number;
  /** Web Push sender; when present, alerts of the configured kinds are pushed. */
  pushSender?: PushSender;
  pushCoalesceMs?: number;
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
  push?: PushService;
  settings(): Settings;
  patchSettings(p: Partial<Settings>): Settings;
  /** Raise an info alert for running units whose context is ≥70 % full. */
  checkContext(): Promise<void>;
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
  const warnedContext = new Set<string>();
  const checkContext = async () => {
    for (const id of units.runtimes.keys()) {
      const u = fleet.units.get(id);
      if (!u || u.status === "offline") continue;
      const usage = await units.contextUsage(id).catch(() => undefined);
      if (usage === undefined) continue;
      if (usage >= 0.7 && !warnedContext.has(id)) {
        warnedContext.add(id);
        alerts.raise({ kind: "info", unitId: id, title: `${u.name}: context ${Math.round(usage * 100)}% full`, body: "Consider /compact before the next long task.", payload: { contextUsage: usage } });
      } else if (usage < 0.5) warnedContext.delete(id);
    }
  };
  let contextTimer: NodeJS.Timeout | null = null;
  let pruneTimer: NodeJS.Timeout | null = null;
  const push = opts.pushSender ? new PushService({ alerts, store: stores.push, settings: () => settingsCache, send: opts.pushSender, log: opts.log, coalesceMs: opts.pushCoalesceMs }) : undefined;
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
    push,
    startedAt,
    pushEnabled: opts.pushEnabled ?? Boolean(opts.pushSender),
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
      push?.start();
      const ctxMs = opts.contextCheckMs ?? 5 * 60_000;
      if (ctxMs > 0) {
        contextTimer = setInterval(() => void checkContext(), ctxMs);
        contextTimer.unref?.();
      }
      pruneTimer = setInterval(() => {
        const n = stores.transcript.pruneAll(5000);
        if (n) opts.log.info({ pruned: n }, "transcript pruned");
      }, 24 * 3600 * 1000);
      pruneTimer.unref?.();
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
    checkContext,
    async shutdown() {
      alerts.stop();
      push?.stop();
      if (contextTimer) clearInterval(contextTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      await units.shutdown();
      fleet.flush();
      db.close();
    },
  };
  return hub;
}
