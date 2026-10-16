import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "./version.js";
import { makeAuthHook } from "./api/auth.js";
import { registerRest, type RestDeps } from "./api/rest.js";
import { registerWs } from "./api/ws.js";
import { ApiError } from "./errors.js";
import type { Hub } from "./hub.js";

export interface AppDeps {
  token: string;
  logLevel?: string;
  hub: Hub;
  /** Built client directory to serve at /. */
  clientDist?: string;
  comms?: RestDeps["comms"];
  push?: RestDeps["push"];
  browseRoots?: string[];
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info" },
    disableRequestLogging: true,
    bodyLimit: 2 * 1024 * 1024,
  });
  const { hub } = deps;

  // Error handler must be installed before child plugins register so they inherit it.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof ApiError) {
      reply.code(err.statusCode).send({ error: { code: err.code, message: err.message } });
      return;
    }
    const e = err as { statusCode?: number; code?: string; message?: string; validation?: unknown };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, "unhandled error");
    reply.code(status).send({
      error: {
        code: status >= 500 ? "internal" : (e.code ?? "bad_request"),
        message: e.message ?? "error",
      },
    });
  });


  app.get("/api/health", async () => ({ ok: true, version: VERSION, units: hub.fleet.units.size }));

  await app.register(
    async (api) => {
      api.addHook("onRequest", makeAuthHook(deps.token));
      registerRest(api, { hub, comms: deps.comms, push: deps.push, browseRoots: deps.browseRoots });
    },
    { prefix: "/api" },
  );

  await registerWs(app, hub, deps.token);

  if (deps.clientDist && existsSync(join(deps.clientDist, "index.html"))) {
    // wildcard routing resolves files on each request, so a rebuilt client (new asset hashes) is
    // served without restarting the server; unknown GETs fall back to the SPA shell.
    await app.register(fastifyStatic, { root: deps.clientDist, prefix: "/", index: ["index.html"], cacheControl: true, maxAge: 0 });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api") && !req.url.startsWith("/ws") && !/\.[a-z0-9]+(\?|$)/i.test(req.url)) {
        return reply.sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "not_found", message: "not found" } });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => {
      reply.code(404).send({ error: { code: "not_found", message: "not found" } });
    });
  }

  return app;
}
