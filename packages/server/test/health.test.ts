import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { tokenMatches } from "../src/api/auth.js";

describe("health + auth", () => {
  it("GET /api/health answers without auth", async () => {
    const app = buildApp({ token: "secret-token-1", logLevel: "silent", unitCount: () => 3 });
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, units: 3 });
    await app.close();
  });
  it("authenticated routes 401 without a bearer token", async () => {
    const app = buildApp({ token: "secret-token-1", logLevel: "silent", unitCount: () => 0 });
    const bad = await app.inject({ method: "GET", url: "/api/ping" });
    expect(bad.statusCode).toBe(401);
    const good = await app.inject({
      method: "GET",
      url: "/api/ping",
      headers: { authorization: "Bearer secret-token-1" },
    });
    expect(good.statusCode).toBe(200);
    await app.close();
  });
  it("tokenMatches is length-safe", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
});
