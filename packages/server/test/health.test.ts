import { afterEach, describe, expect, it } from "vitest";
import { tokenMatches } from "../src/api/auth.js";
import { createTestApp, createTestHub, exampleFleet } from "./helpers.js";

describe("health + auth", () => {
  const t = createTestHub();
  afterEach(async () => {});

  it("GET /api/health answers without auth", async () => {
    await t.hub.boot(exampleFleet(), { autostart: false });
    const { app } = await createTestApp(t);
    const res = await app.inject({ method: "GET", url: "/api/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, units: 14 });
    await app.close();
  });

  it("authenticated routes 401 without a bearer token", async () => {
    const { app, auth } = await createTestApp(t);
    const bad = await app.inject({ method: "GET", url: "/api/state" });
    expect(bad.statusCode).toBe(401);
    expect(bad.json()).toEqual({ error: { code: "unauthorized", message: "missing or bad token" } });
    const wrong = await app.inject({ method: "GET", url: "/api/state", headers: { authorization: "Bearer nope" } });
    expect(wrong.statusCode).toBe(401);
    const good = await app.inject({ method: "GET", url: "/api/state", headers: auth });
    expect(good.statusCode).toBe(200);
    await app.close();
  });

  it("tokenMatches is length-safe", () => {
    expect(tokenMatches("abc", "abc")).toBe(true);
    expect(tokenMatches("ab", "abc")).toBe(false);
    expect(tokenMatches(undefined, "abc")).toBe(false);
  });
});
