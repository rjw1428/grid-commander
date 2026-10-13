import { describe, expect, it } from "vitest";
import type { UnitStatus } from "@hexcommand/shared";
import { DemoRuntime } from "../src/runtime/DemoRuntime.js";

const mk = () => new DemoRuntime({ unitId: "d", name: "d", model: "sonnet", permissionMode: "default", speed: 0.02 });
const until = async (pred: () => boolean) => {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > 3000) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 5));
  }
};

describe("DemoRuntime", () => {
  it("plain order: idle → working → done", async () => {
    const rt = mk();
    const statuses: UnitStatus[] = [];
    rt.on("status", (s) => statuses.push(s));
    await rt.start();
    const r = await rt.submit("do a thing", "operator");
    expect(r.ok).toBe(true);
    expect(statuses).toEqual(["idle", "working", "done"]);
    await rt.stop();
    expect(rt.status).toBe("offline");
    expect(rt.sessionId).toMatch(/^demo-/);
  });
  it("permission and question paths wait for the operator; fail errors; long interrupts", async () => {
    const rt = mk();
    await rt.start();
    const p = rt.submit("needs permission", "operator");
    await until(() => rt.status === "waiting");
    expect(rt.answerPermission({ allow: true })).toBe(true);
    expect((await p).text).toMatch(/green/);
    const q = rt.submit("ask a question", "operator");
    await until(() => rt.status === "waiting");
    expect(rt.answerQuestion({ "Which approach should I take?": "Refactor" })).toBe(true);
    expect((await q).text).toMatch(/Refactor/);
    const f = await rt.submit("please fail", "operator");
    expect(f.ok).toBe(false);
    const l = rt.submit("a long one", "operator");
    await until(() => rt.status === "working");
    await rt.interrupt();
    expect((await l).interrupted).toBe(true);
    await rt.stop();
  });
});
