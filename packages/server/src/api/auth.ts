import { timingSafeEqual } from "node:crypto";
import type { FastifyReply, FastifyRequest } from "fastify";

export function tokenMatches(presented: string | undefined, expected: string): boolean {
  if (!presented) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m?.[1];
}

export function makeAuthHook(token: string) {
  return async function authHook(req: FastifyRequest, reply: FastifyReply) {
    // WS upgrades carry the token in the query string; REST in the header.
    const query = req.query as Record<string, unknown> | undefined;
    const presented =
      extractBearer(req.headers.authorization) ??
      (typeof query?.token === "string" ? query.token : undefined);
    if (!tokenMatches(presented, token)) {
      reply.code(401).send({ error: { code: "unauthorized", message: "missing or bad token" } });
      return reply;
    }
    return undefined;
  };
}
