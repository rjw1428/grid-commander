import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { listDirs } from "../src/api/fsBrowse.js";
import { createTestHub, exampleFleet, TOKEN } from "./helpers.js";

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gridcommander-fs-")));
  mkdirSync(join(root, "alpha", ".git"), { recursive: true });
  mkdirSync(join(root, "beta"));
  mkdirSync(join(root, ".hidden"));
  writeFileSync(join(root, "file.txt"), "x");
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "gridcommander-out-")));
  symlinkSync(outside, join(root, "escape"));
  return { root, outside };
}

describe("directory browser", () => {
  it("lists directories only, marks git repos, hides dotdirs, follows symlinked folders by logical path", () => {
    const { root } = fixture();
    const l = listDirs([root], undefined);
    expect(l.path).toBe(root);
    expect(l.parent).toBeNull();
    expect(l.entries.map((e) => e.name)).toEqual(["alpha", "beta", "escape"]);
    const viaLink = listDirs([root], join(root, "escape"));
    expect(viaLink.path).toBe(join(root, "escape"));
    expect(viaLink.parent).toBe(root);
    expect(l.entries.find((e) => e.name === "alpha")?.git).toBe(true);
    expect(listDirs([root], root, true).entries.map((e) => e.name)).toContain(".hidden");
    const sub = listDirs([root], join(root, "alpha"));
    expect(sub.parent).toBe(root);
    expect(sub.git).toBe(true);
  });

  it("refuses paths outside the roots, including via ..", () => {
    const { root, outside } = fixture();
    expect(() => listDirs([root], outside)).toThrow(/outside/);
    expect(() => listDirs([root], join(root, "..", "..", "etc"))).toThrow(/outside|not found/);
    expect(() => listDirs([root], join(root, "alpha", "..", "..", "x"))).toThrow(/outside|not found/);
    expect(() => listDirs([root], join(root, "file.txt"))).toThrow(/not a directory/);
    expect(() => listDirs([root], join(root, "nope"))).toThrow(/not found/);
  });

  it("is exposed at GET /api/fs/dirs behind the token", async () => {
    const { root } = fixture();
    const t = createTestHub();
    await t.hub.boot(exampleFleet(), { autostart: false });
    const app = await buildApp({ token: TOKEN, logLevel: "silent", hub: t.hub, browseRoots: [root] });
    const anon = await app.inject({ method: "GET", url: "/api/fs/dirs" });
    expect(anon.statusCode).toBe(401);
    const ok = await app.inject({ method: "GET", url: "/api/fs/dirs", headers: { authorization: `Bearer ${TOKEN}` } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().entries.map((e: { name: string }) => e.name)).toEqual(["alpha", "beta", "escape"]);
    const bad = await app.inject({ method: "GET", url: `/api/fs/dirs?path=${encodeURIComponent("/")}`, headers: { authorization: `Bearer ${TOKEN}` } });
    expect(bad.statusCode).toBe(400);
    await app.close();
  });
});
