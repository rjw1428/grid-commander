import { describe, expect, it } from "vitest";
import {
  FleetConfigSchema,
  UNIT_TYPES,
  UnitSchema,
  WsServerEventSchema,
  hexToWorld,
  hexDistance,
  getUnitType,
} from "../src/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("unit types", () => {
  it("ships the six types from the spec", () => {
    expect(UNIT_TYPES.map((t) => t.id).sort()).toEqual(
      ["captain", "engineer", "general", "infantry", "major", "sniper"].sort(),
    );
  });
  it("gives fleet comms scope to general and major only", () => {
    for (const t of UNIT_TYPES) {
      const expected = t.id === "general" || t.id === "major" ? "fleet" : "project";
      expect(t.commsScope, t.id).toBe(expected);
      expect(t.canInterrupt, t.id).toBe(expected === "fleet");
    }
  });
  it("throws for unknown types", () => {
    expect(() => getUnitType("nope")).toThrow(/unknown unit type/);
  });
});

describe("fleet.example.json", () => {
  it("validates against FleetConfigSchema", () => {
    const raw = JSON.parse(readFileSync(join(here, "../../../fleet.example.json"), "utf8"));
    const cfg = FleetConfigSchema.parse(raw);
    expect(cfg.projects.length).toBeGreaterThan(0);
    expect(cfg.units.length).toBe(14);
    // every unit sits on a cell its project owns
    const cells = new Map(cfg.projects.map((p) => [p.id, new Set(p.cells.map((c) => c.join(",")))]));
    for (const u of cfg.units) {
      expect(cells.get(u.projectId)?.has(u.hex!.join(",")), u.id).toBe(true);
    }
  });
});

describe("Unit schema", () => {
  it("rejects bad slugs and accepts a minimal unit", () => {
    const base = {
      id: "xre-plan",
      name: "xre-plan",
      type: "engineer",
      projectId: "xre",
      hex: [0, 0],
      task: "",
      status: "offline",
      statusSince: 0,
      model: "opus",
      permissionMode: "acceptEdits",
      queueLength: 0,
      unreadInbox: 0,
      createdAt: 0,
    };
    expect(UnitSchema.safeParse(base).success).toBe(true);
    expect(UnitSchema.safeParse({ ...base, id: "Bad Slug" }).success).toBe(false);
    expect(UnitSchema.safeParse({ ...base, status: "sleeping" }).success).toBe(false);
  });
});

describe("WS events", () => {
  it("parses a unit.remove and rejects unknown types", () => {
    expect(WsServerEventSchema.safeParse({ type: "unit.remove", id: "x" }).success).toBe(true);
    expect(WsServerEventSchema.safeParse({ type: "unit.explode", id: "x" }).success).toBe(false);
  });
});

describe("hex math", () => {
  it("matches the prototype projection", () => {
    expect(hexToWorld([0, 0])).toEqual({ x: 0, z: 0 });
    expect(hexToWorld([1, 0]).x).toBeCloseTo(Math.sqrt(3));
    expect(hexToWorld([0, 1])).toEqual({ x: Math.sqrt(3) / 2, z: 1.5 });
  });
  it("computes distances", () => {
    expect(hexDistance([0, 0], [2, -1])).toBe(2);
    expect(hexDistance([0, 0], [0, 0])).toBe(0);
  });
});
