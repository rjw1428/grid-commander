import { describe, expect, it } from "vitest";
import { canAcceptTurn, isBusy, nextStatus } from "../src/runtime/statusMachine.js";
import type { UnitStatus } from "@gridcommander/shared";

const ALL: UnitStatus[] = ["offline", "idle", "working", "waiting", "done", "error"];

describe("statusMachine", () => {
  it("stop always goes offline", () => {
    for (const s of ALL) expect(nextStatus(s, { type: "stop" })).toBe("offline");
  });
  it("init only lifts offline", () => {
    expect(nextStatus("offline", { type: "init" })).toBe("idle");
    expect(nextStatus("working", { type: "init" })).toBe("working");
  });
  it("submit from idle/done/error → working; never from offline", () => {
    for (const s of ["idle", "done", "error"] as const) expect(nextStatus(s, { type: "submit" })).toBe("working");
    expect(nextStatus("offline", { type: "submit" })).toBe("offline");
  });
  it("wait/answered round trip", () => {
    expect(nextStatus("working", { type: "wait" })).toBe("waiting");
    expect(nextStatus("waiting", { type: "answered" })).toBe("working");
    expect(nextStatus("idle", { type: "wait" })).toBe("idle");
  });
  it("result ok/err from working or waiting", () => {
    expect(nextStatus("working", { type: "result", ok: true })).toBe("done");
    expect(nextStatus("waiting", { type: "result", ok: false })).toBe("error");
    expect(nextStatus("idle", { type: "result", ok: true })).toBe("idle");
  });
  it("ack clears done/error", () => {
    expect(nextStatus("done", { type: "ack" })).toBe("idle");
    expect(nextStatus("error", { type: "ack" })).toBe("idle");
    expect(nextStatus("working", { type: "ack" })).toBe("working");
  });
  it("crash → error while busy, offline otherwise", () => {
    expect(nextStatus("working", { type: "crash" })).toBe("error");
    expect(nextStatus("waiting", { type: "crash" })).toBe("error");
    expect(nextStatus("idle", { type: "crash" })).toBe("offline");
  });
  it("helpers", () => {
    expect(ALL.filter(canAcceptTurn)).toEqual(["idle", "done", "error"]);
    expect(ALL.filter(isBusy)).toEqual(["working", "waiting"]);
  });
});
