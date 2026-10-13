import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import type { WsServerEvent } from "@gridcommander/shared";
import { WsServerEventSchema } from "@gridcommander/shared";
import { createTestApp, createTestHub, exampleFleet, TOKEN, until } from "./helpers.js";
import { scripts } from "./fakeSdk.js";

describe("WebSocket /ws", () => {
  const t = createTestHub({ turns: [scripts.happy("pong!")] });
  let app: Awaited<ReturnType<typeof createTestApp>>["app"];
  let req: Awaited<ReturnType<typeof createTestApp>>["req"];
  let port: number;

  beforeAll(async () => {
    await t.hub.boot(exampleFleet(), { autostart: false });
    const a = await createTestApp(t);
    app = a.app;
    req = a.req;
    await app.listen({ port: 0, host: "127.0.0.1" });
    const addr = app.server.address();
    port = typeof addr === "object" && addr ? addr.port : 0;
  });
  afterAll(async () => {
    await app.close();
    await t.hub.shutdown();
  });

  it("rejects the upgrade without a token", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    const code = await new Promise<number>((resolve) => {
      ws.on("unexpected-response", (_r, res) => resolve(res.statusCode ?? 0));
      ws.on("error", () => {});
    });
    expect(code).toBe(401);
  });

  it("sends a snapshot on connect, then unit.upsert after an order, and answers ping", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${TOKEN}`);
    const events: WsServerEvent[] = [];
    ws.on("message", (raw) => {
      const parsed = WsServerEventSchema.safeParse(JSON.parse(raw.toString()));
      expect(parsed.success).toBe(true);
      if (parsed.success) events.push(parsed.data);
    });
    await new Promise<void>((resolve) => ws.on("open", () => resolve()));
    await until(() => events.length >= 1);
    expect(events[0]!.type).toBe("snapshot");
    if (events[0]!.type === "snapshot") expect(events[0]!.state.units).toHaveLength(14);

    ws.send(JSON.stringify({ type: "ping" }));
    await until(() => events.some((e) => e.type === "pong"));

    await req("POST", "/units/xre-scout/start");
    await req("POST", "/units/xre-scout/orders", { text: "ping" });
    await until(() => events.some((e) => e.type === "unit.upsert" && e.unit.id === "xre-scout" && e.unit.status === "done"), 4000, "done upsert");
    const statuses = events.filter((e) => e.type === "unit.upsert" && e.unit.id === "xre-scout").map((e) => (e as { unit: { status: string } }).unit.status);
    expect(statuses).toContain("idle");
    expect(statuses).toContain("working");
    expect(statuses.at(-1)).toBe("done");
    expect(events.some((e) => e.type === "unit.transcript" && e.unitId === "xre-scout")).toBe(true);
    expect(events.some((e) => e.type === "alert.upsert" && e.alert.kind === "done")).toBe(true);
    ws.close();
  });
});
