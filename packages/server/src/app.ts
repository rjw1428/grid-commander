import Fastify, { type FastifyInstance } from "fastify";
import { VERSION } from "./version.js";
import { makeAuthHook } from "./api/auth.js";

export interface AppDeps {
  token: string;
  logLevel?: string;
  unitCount: () => number;
}

/** Builds the Fastify instance. M0: health + auth skeleton; routes are added in M2. */
export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify({
    logger: { level: deps.logLevel ?? "info" },
    disableRequestLogging: true,
  });

  app.get("/api/health", async () => ({ ok: true, version: VERSION, units: deps.unitCount() }));

  app.register(async (api) => {
    api.addHook("onRequest", makeAuthHook(deps.token));
    api.get("/ping", async () => ({ ok: true }));
  }, { prefix: "/api" });

  app.setErrorHandler((err: unknown, _req, reply) => {
    const e = err as { statusCode?: number; code?: string; message?: string };
    const status = e.statusCode ?? 500;
    if (status >= 500) app.log.error({ err }, "unhandled error");
    reply.code(status).send({
      error: {
        code: status >= 500 ? "internal" : (e.code ?? "bad_request"),
        message: e.message ?? "error",
      },
    });
  });

  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: { code: "not_found", message: "not found" } });
  });

  return app;
}
