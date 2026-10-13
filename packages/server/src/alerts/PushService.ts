import type { Alert, Settings } from "@hexcommand/shared";
import type { AlertEngine } from "./AlertEngine.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";
import type { PushStore, StoredPushSubscription } from "../store/stores.js";

export interface PushPayload {
  title: string;
  body: string;
  tag: string;
  url: string;
  kind: Alert["kind"];
  unitId?: string;
}

/** Abstract sender so tests do not need VAPID keys. web-push's sendNotification fits this shape. */
export type PushSender = (sub: StoredPushSubscription, payload: string) => Promise<void>;

export class PushGone extends Error {
  constructor(public statusCode: number) {
    super(`push endpoint gone (${statusCode})`);
  }
}

export interface PushServiceDeps {
  alerts: AlertEngine;
  store: PushStore;
  settings: () => Settings;
  send: PushSender;
  log: RuntimeLogger;
  /** Minimum gap between pushes for the same unit. */
  coalesceMs?: number;
}

/** Web Push on operator alerts: kinds from settings, at most one push per unit per minute. */
export class PushService {
  #d: PushServiceDeps;
  #last = new Map<string, number>();
  #off: (() => void) | null = null;
  sent = 0;

  constructor(deps: PushServiceDeps) {
    this.#d = deps;
  }

  start(): void {
    this.#off = this.#d.alerts.on("raised", (alert, isNew) => void this.onAlert(alert, isNew));
  }
  stop(): void {
    this.#off?.();
    this.#off = null;
  }

  async onAlert(alert: Alert, isNew: boolean): Promise<void> {
    const kinds = this.#d.settings()["push.kinds"];
    if (!kinds.includes(alert.kind)) return;
    if (!isNew && alert.kind !== "waiting") return; // a refreshed idle/done tile is not news
    const key = alert.unitId ?? `kind:${alert.kind}`;
    const now = Date.now();
    const gap = this.#d.coalesceMs ?? 60_000;
    if (now - (this.#last.get(key) ?? 0) < gap) return;
    const subs = this.#d.store.all();
    if (!subs.length) return;
    this.#last.set(key, now);
    const payload: PushPayload = {
      title: alert.title,
      body: alert.body,
      tag: key,
      url: alert.unitId ? `/#unit-${alert.unitId}` : "/",
      kind: alert.kind,
      ...(alert.unitId ? { unitId: alert.unitId } : {}),
    };
    const json = JSON.stringify(payload);
    await Promise.all(
      subs.map(async (sub) => {
        try {
          await this.#d.send(sub, json);
          this.sent += 1;
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode;
          if (status === 404 || status === 410) {
            this.#d.store.remove(sub.endpoint);
            this.#d.log.info({ endpoint: sub.endpoint.slice(0, 40) }, "push subscription expired; removed");
          } else {
            this.#d.log.warn({ err }, "push send failed");
          }
        }
      }),
    );
  }
}

/** Real sender backed by the web-push library. */
export async function createWebPushSender(keys: { publicKey: string; privateKey: string; subject: string }): Promise<PushSender> {
  const webpush = (await import("web-push")).default;
  webpush.setVapidDetails(keys.subject, keys.publicKey, keys.privateKey);
  return async (sub, payload) => {
    await webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys, expirationTime: sub.expirationTime ?? null }, payload, { TTL: 300, urgency: "high" });
  };
}
