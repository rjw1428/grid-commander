import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { WsClientEventSchema, type WsServerEvent } from "@gridcommander/shared";
import type { Hub } from "../hub.js";
import { makeAuthHook } from "./auth.js";

export interface WsStats {
  clients: () => number;
}

/** /ws?token=  — snapshot on connect, then every bus event. Client only sends ping. */
export async function registerWs(app: FastifyInstance, hub: Hub, token: string): Promise<WsStats> {
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });
  const sockets = new Set<import("ws").WebSocket>();

  const send = (ws: import("ws").WebSocket, e: WsServerEvent) => {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(e));
    } catch (err) {
      app.log.debug({ err }, "ws send failed");
    }
  };

  hub.bus.on("event", (e) => {
    for (const ws of sockets) send(ws, e);
  });

  app.register(async (scope) => {
    scope.addHook("onRequest", makeAuthHook(token));
    scope.get("/ws", { websocket: true }, (socket) => {
      sockets.add(socket);
      send(socket, { type: "snapshot", state: hub.snapshot() });
      socket.on("message", (raw: Buffer | string) => {
        try {
          const parsed = WsClientEventSchema.safeParse(JSON.parse(raw.toString()));
          if (parsed.success && parsed.data.type === "ping") send(socket, { type: "pong" });
        } catch {
          /* ignore garbage */
        }
      });
      const cleanup = () => sockets.delete(socket);
      socket.on("close", cleanup);
      socket.on("error", cleanup);
    });
  });

  // keep clients fresh on server info every 30 s (uptime, running count)
  const timer = setInterval(() => {
    if (!sockets.size) return;
    const snap = hub.snapshot();
    for (const ws of sockets) send(ws, { type: "server.info", info: snap.server });
  }, 30_000);
  timer.unref?.();
  app.addHook("onClose", async () => {
    clearInterval(timer);
    for (const ws of sockets) ws.close(1001, "server shutting down");
  });

  return { clients: () => sockets.size };
}
