import { describe, expect, it } from "vitest";
import { createTestHub, exampleFleet, until } from "./helpers.js";
import { PushGone } from "../src/alerts/PushService.js";
import { scripts } from "./fakeSdk.js";

describe("PushService", () => {
  it("pushes waiting alerts to every subscription, coalesces per unit, prunes dead endpoints", async () => {
    const sent: { endpoint: string; payload: Record<string, unknown> }[] = [];
    const t = createTestHub({
      turns: [scripts.permission(), scripts.happy()],
      hub: {
        pushCoalesceMs: 60_000,
        pushSender: async (sub, payload) => {
          if (sub.endpoint.includes("dead")) throw new PushGone(410);
          sent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
        },
      },
    });
    await t.hub.boot(exampleFleet(), { autostart: false });
    expect(t.hub.snapshot().server.pushEnabled).toBe(true);
    t.hub.stores.push.upsert({ endpoint: "https://push.example/alive", keys: { p256dh: "p", auth: "a" } });
    t.hub.stores.push.upsert({ endpoint: "https://push.example/dead", keys: { p256dh: "p", auth: "a" } });
    await t.hub.units.start("api-build");
    await t.hub.orders.enqueue("api-build", "run tests", "operator");
    await until(() => t.hub.fleet.getUnit("api-build").status === "waiting");
    await until(() => sent.length === 1);
    expect(sent[0]!.payload).toMatchObject({ kind: "waiting", unitId: "api-build", url: "/#unit-api-build", tag: "api-build" });
    expect(t.hub.stores.push.all().map((s) => s.endpoint)).toEqual(["https://push.example/alive"]);
    t.hub.units.answerPermission("api-build", { allow: true });
    await until(() => t.hub.fleet.getUnit("api-build").status === "done");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(1); // done within the coalesce window is suppressed
    // info alerts are not pushed by default
    t.hub.alerts.raise({ kind: "info", unitId: "xre-plan", title: "x", body: "y" });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.length).toBe(1);
    t.hub.patchSettings({ "push.kinds": ["info"] });
    t.hub.alerts.raise({ kind: "info", unitId: "xre-cache", title: "x", body: "y" });
    await until(() => sent.length === 2);
    await t.hub.shutdown();
  });
});
