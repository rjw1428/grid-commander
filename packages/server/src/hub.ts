import { getUnitType, UNIT_TYPES, type FleetConfig, type Settings, type Snapshot } from "@gridcommander/shared";
import { AlertEngine } from "./alerts/AlertEngine.js";
import { Bus } from "./bus.js";
import { FleetService } from "./fleet/FleetService.js";
import { OrderService } from "./fleet/OrderService.js";
import { UnitService, type RuntimeFactory, type RuntimeFactoryCtx } from "./fleet/UnitService.js";
import { buildUnitSystemPrompt } from "./runtime/systemPrompt.js";
import { UnitRuntime, realSdk, type RuntimeLogger, type SdkFacade } from "./runtime/UnitRuntime.js";
import { DemoRuntime } from "./runtime/DemoRuntime.js";
import { CommsBroker } from "./comms/CommsBroker.js";
import { FLEET_TOOL_NAMES, fleetServerForUnit, fleetToolHandler, fleetToolsForUnit } from "./comms/fleetTools.js";
import { hooksForUnit } from "./comms/hooks.js";
import { PushService, type PushSender } from "./alerts/PushService.js";
import { HostClient, type HostSpawnOptions } from "./host/HostClient.js";
import { RemoteRuntime } from "./host/RemoteRuntime.js";
import type { UnitSpec } from "./host/protocol.js";
import { openDb, type Db } from "./store/db.js";
import { createStores, type Stores } from "./store/stores.js";
import { VERSION } from "./version.js";

export interface HubHostOptions {
  socketPath: string;
  /** How to launch the host when none is listening; omit to require an already-running host. */
  spawn?: HostSpawnOptions;
  connectTimeoutMs?: number;
  /** Delay before trying to bring the host back after its connection drops. */
  reconnectDelayMs?: number;
}

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
  /** Run sessions in the detached unit host so they survive hub restarts. */
  host?: HubHostOptions;
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
  /** Present when sessions live in the unit host. */
  host?: HostClient;
  settings(): Settings;
  patchSettings(p: Partial<Settings>): Settings;
  /** Raise an info alert for running units whose context is ≥70 % full. */
  checkContext(): Promise<void>;
  snapshot(): Snapshot;
  /** Load fleet.json + DB, re-attach or recover units that were running, start autostart units. */
  boot(cfg: FleetConfig, opts?: { autostart?: boolean }): Promise<void>;
  /** Stops units when they run in-process; detaches from the host (units keep running) otherwise. */
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

/** Everything the unit host needs to build this unit's session. */
export function unitSpecFor({ unit, type, project, cwd, comms }: RuntimeFactoryCtx): UnitSpec {
  return {
    unitId: unit.id,
    name: unit.name,
    cwd,
    model: unit.model,
    permissionMode: unit.permissionMode,
    ...(unit.sessionId ? { sessionId: unit.sessionId } : {}),
    systemPromptAppend: buildUnitSystemPrompt(unit, type, project),
    fleetTools: comms ? fleetToolsForUnit(unit) : [],
    nudgeHook: Boolean(comms),
  };
}

export function hostRuntimeFactory(client: HostClient, log: RuntimeLogger, ensure?: () => Promise<unknown>): RuntimeFactory {
  return (ctx) => new RemoteRuntime(client, unitSpecFor(ctx), log, undefined, ensure);
}

export function createHub(opts: HubOptions): Hub {
  const db = openDb(opts.dbPath);
  const stores = createStores(db);
  const bus = new Bus((err, ev) => opts.log.error({ err, ev }, "bus listener threw"));
  const fleet = new FleetService({ stores, bus, configPath: opts.configPath, log: opts.log, fleetRoot: opts.fleetRoot });
  const commsRef: { current?: CommsBroker } = {};

  const host = opts.host
    ? new HostClient({
        socketPath: opts.host.socketPath,
        spawn: opts.host.spawn,
        connectTimeoutMs: opts.host.connectTimeoutMs,
        log: opts.log,
        hubVersion: VERSION,
        bridge: async (unitId, kind, name, args) => {
          const comms = commsRef.current;
          if (!comms) throw new Error("fleet comms not ready");
          if (kind === "nudge") return comms.nudge(unitId);
          return fleetToolHandler(unitId, () => fleet.getUnit(unitId), comms)(name, args);
        },
      })
    : undefined;

  // Late-bound: attachHost needs services constructed below. Starting a unit while the host is not
  // attached connects (spawning the host if needed) and adopts whatever it still runs first.
  let attaching: Promise<Set<string>> | null = null;
  const ensureHost = (): Promise<Set<string>> => {
    if (!host || host.connected) return Promise.resolve(new Set());
    if (!attaching) attaching = attachHost().finally(() => (attaching = null));
    return attaching;
  };
  const factory = opts.factory ?? (opts.demo && !host ? demoRuntimeFactory() : host ? hostRuntimeFactory(host, opts.log, ensureHost) : defaultRuntimeFactory(opts.sdk ?? realSdk, opts.log));
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
  let reconnectTimer: NodeJS.Timeout | null = null;
  let shuttingDown = false;
  const push = opts.pushSender ? new PushService({ alerts, store: stores.push, settings: () => settingsCache, send: opts.pushSender, log: opts.log, coalesceMs: opts.pushCoalesceMs }) : undefined;
  const startedAt = Date.now();
  const publishInfo = () => bus.publish({ type: "server.info", info: hub.snapshot().server });
  units.on("started", publishInfo);
  units.on("stopped", publishInfo);

  /**
   * A unit's session is gone (hub restart without a host, host crash, host restart): hand its
   * in-flight order back to the queue and bring the session back by resuming it.
   */
  const settleOrders = (id: string, reason: string, midTurn: boolean): void => {
    const u = fleet.units.get(id);
    if (!u) return;
    const requeued = orders.recover(id, { wasMidTurn: midTurn });
    if (midTurn) {
      alerts.raise({
        kind: "info",
        unitId: id,
        title: u.name,
        body: requeued ? `was mid-order when ${reason}; the order is back in the queue and the session will resume` : `was mid-turn when ${reason}; the session will resume`,
      });
    }
  };
  const resumeUnit = async (id: string): Promise<void> => {
    if (opts.autoStartOnOrder === false || units.runtime(id) || !fleet.units.has(id)) return;
    try {
      await units.start(id);
    } catch (err) {
      opts.log.warn({ err, unitId: id }, "resume after loss failed");
    }
  };
  const recoverUnit = async (id: string, reason: string, midTurn: boolean): Promise<void> => {
    settleOrders(id, reason, midTurn);
    await resumeUnit(id);
  };

  /** Connect to the host and adopt every unit it still runs. Returns the ids adopted. */
  const attachHost = async (): Promise<Set<string>> => {
    const adopted = new Set<string>();
    if (!host) return adopted;
    const hello = await host.connect();
    for (const hosted of hello.units) {
      const id = hosted.spec.unitId;
      if (!fleet.units.has(id)) {
        opts.log.warn({ unitId: id }, "host runs a unit that is no longer in the fleet; stopping it");
        void host.request({ type: "stop", id: `stop-${id}`, unitId: id }).catch(() => undefined);
        continue;
      }
      try {
        units.attach(id, new RemoteRuntime(host, hosted.spec, opts.log, hosted));
        adopted.add(id);
      } catch (err) {
        opts.log.warn({ err, unitId: id }, "could not re-attach hosted unit");
      }
    }
    if (hello.hostVersion !== VERSION) {
      alerts.raise({ kind: "info", title: "Unit host is running an older build", body: `host ${hello.hostVersion}, server ${VERSION}. Run \`pnpm host:restart\` when the fleet is idle to pick up host-side changes.` });
    }
    return adopted;
  };

  // A graceful host shutdown stops its units (their exits reach us first) and then closes the socket;
  // the `closing` notice tells us which units to bring back and which were mid-turn at that moment.
  const closing = { ids: new Set<string>(), midTurn: new Set<string>() };
  host?.on("closing", (ids) => {
    for (const id of ids) {
      closing.ids.add(id);
      const u = fleet.units.get(id);
      if (u && (u.status === "working" || u.status === "waiting")) closing.midTurn.add(id);
    }
  });

  /** The host went away: bring it back and resume every unit it was running. */
  const onHostLost = (reason: string) => {
    if (shuttingDown) return;
    // runs before the runtimes process the disconnect, so statuses are still the live ones
    const lost = new Set(closing.ids);
    const midTurn = new Set(closing.midTurn);
    closing.ids.clear();
    closing.midTurn.clear();
    for (const u of fleet.units.values()) {
      if (!units.runtime(u.id)) continue;
      lost.add(u.id);
      if (u.status === "working" || u.status === "waiting") midTurn.add(u.id);
    }
    alerts.raise({ kind: "error", title: "Unit host disconnected", body: `${reason}. Restarting it and resuming ${lost.size} unit(s).` });
    // orders go back to the queue now (the UI shows them waiting); sessions resume once a host is up
    for (const id of lost) settleOrders(id, "the unit host stopped", midTurn.has(id));
    const delay = opts.host?.reconnectDelayMs ?? 1000;
    const attempt = async (n: number) => {
      reconnectTimer = null;
      if (shuttingDown) return;
      try {
        const adopted = await ensureHost();
        for (const id of lost) if (!adopted.has(id)) await resumeUnit(id);
      } catch (err) {
        opts.log.error({ err, attempt: n }, "unit host unreachable");
        if (n >= 10) {
          alerts.raise({ kind: "error", title: "Unit host unreachable", body: "Could not restart the unit host. Check data/host.log, then run `pnpm host:restart`." });
          return;
        }
        reconnectTimer = setTimeout(() => void attempt(n + 1), Math.min(30_000, delay * 2 ** n));
      }
    };
    reconnectTimer = setTimeout(() => void attempt(0), delay);
  };
  host?.on("disconnect", onHostLost);

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
    host,
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

      // Units the host kept alive come back exactly as they were; nothing to recover for them.
      let adopted = new Set<string>();
      if (host) {
        try {
          adopted = await ensureHost();
        } catch (err) {
          opts.log.error({ err }, "could not reach the unit host at boot; units will be resumed in it when it comes up");
          alerts.raise({ kind: "error", title: "Unit host unreachable", body: `${err instanceof Error ? err.message : String(err)}. Check data/host.log.` });
        }
      }
      const midTurn = new Set(wasWorking.map((u) => u.id));
      for (const u of fleet.units.values()) {
        if (adopted.has(u.id)) continue;
        if (midTurn.has(u.id)) {
          if (bootOpts.autostart === false) {
            orders.recover(u.id, { wasMidTurn: true });
            alerts.raise({ kind: "info", unitId: u.id, title: u.name, body: "was mid-turn when the server stopped; its order is back in the queue" });
          } else await recoverUnit(u.id, "the server stopped", true);
        } else orders.recover(u.id, { wasMidTurn: false });
      }
      if (bootOpts.autostart !== false) {
        for (const u of fleet.units.values()) {
          // autostart units, and units with orders waiting (resume so the queue drains)
          if (units.runtime(u.id)) continue;
          if (!u.autostart && !(opts.autoStartOnOrder !== false && stores.orders.pending(u.id).length)) continue;
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
      shuttingDown = true;
      alerts.stop();
      push?.stop();
      if (contextTimer) clearInterval(contextTimer);
      if (pruneTimer) clearInterval(pruneTimer);
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (host) {
        const kept = units.detachAll();
        host.disconnect();
        if (kept.length) opts.log.info({ units: kept.length }, "detached from the unit host; sessions keep running");
      } else {
        // sessions die with this process: hand in-flight orders back so the next boot resubmits them
        for (const [id, rt] of units.runtimes) if (rt.inFlight) orders.recover(id, { wasMidTurn: true });
        await units.shutdown();
      }
      fleet.flush();
      db.close();
    },
  };
  return hub;
}
