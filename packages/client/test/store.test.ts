import { beforeEach, describe, expect, it } from "vitest";
import type { Snapshot, Unit } from "@hexcommand/shared";
import { UNIT_TYPES, SettingsSchema } from "@hexcommand/shared";
import { useFleet } from "../src/store/useFleet.js";

const unit = (id: string, extra: Partial<Unit> = {}): Unit => ({
  id,
  name: id,
  type: "infantry",
  projectId: "p",
  hex: [0, 0],
  task: "",
  status: "offline",
  statusSince: 0,
  model: "sonnet",
  permissionMode: "default",
  queueLength: 0,
  unreadInbox: 0,
  createdAt: 0,
  ...extra,
});

const snapshot = (): Snapshot => ({
  projects: [{ id: "p", name: "P", cwd: "/x", tint: "#223344", flag: "#aabbcc", cells: [[0, 0], [1, 0]] }],
  teams: [],
  units: [unit("a"), unit("b", { hex: [1, 0] })],
  alerts: [],
  unitTypes: [...UNIT_TYPES],
  settings: SettingsSchema.parse({}),
  server: { version: "t", uptime: 0, runningUnits: 0, maxUnits: 24, pushEnabled: false, hasHq: false },
});

describe("fleet store", () => {
  beforeEach(() => {
    useFleet.getState().applySnapshot(snapshot());
    useFleet.getState().clearSelection();
  });

  it("applies snapshot and deltas", () => {
    const s = useFleet.getState();
    expect(Object.keys(s.units)).toEqual(["a", "b"]);
    s.applyEvent({ type: "unit.upsert", unit: unit("a", { status: "working", activity: "Bash: ls" }) });
    expect(useFleet.getState().units.a?.status).toBe("working");
    s.applyEvent({ type: "unit.remove", id: "b" });
    expect(useFleet.getState().units.b).toBeUndefined();
    s.applyEvent({ type: "alert.upsert", alert: { id: "x", kind: "done", unitId: "a", title: "t", body: "b", createdAt: 1 } });
    expect(useFleet.getState().alerts.x?.kind).toBe("done");
    expect(useFleet.getState().banner?.id).toBe("x");
    s.applyEvent({ type: "alert.remove", id: "x" });
    expect(useFleet.getState().alerts.x).toBeUndefined();
    expect(useFleet.getState().banner).toBeNull();
  });

  it("appends transcript only when loaded, updates tool results in place, keeps the ring bounded", () => {
    const s = useFleet.getState();
    s.applyEvent({ type: "unit.transcript", unitId: "a", entries: [{ kind: "user", at: 1, text: "hi", source: "operator" }] });
    expect(useFleet.getState().transcripts.a).toBeUndefined();
    s.setTranscript("a", [{ kind: "tool", at: 1, name: "Bash", summary: "Bash: ls", toolUseId: "t1" }]);
    s.applyEvent({ type: "unit.transcriptUpdate", unitId: "a", toolUseId: "t1", ok: true, durationMs: 12 });
    expect(useFleet.getState().transcripts.a?.[0]).toMatchObject({ ok: true, durationMs: 12 });
    const many = Array.from({ length: 600 }, (_, i) => ({ kind: "assistant" as const, at: i, text: String(i) }));
    s.applyEvent({ type: "unit.transcript", unitId: "a", entries: many });
    expect(useFleet.getState().transcripts.a?.length).toBe(500);
  });

  it("selection drives the panel", () => {
    const s = useFleet.getState();
    s.select(["a"]);
    expect(useFleet.getState().panel).toEqual({ kind: "unit", id: "a" });
    s.toggleSelect("b");
    expect(useFleet.getState().panel).toEqual({ kind: "group", ids: ["a", "b"] });
    s.toggleSelect("a");
    expect(useFleet.getState().panel).toEqual({ kind: "unit", id: "b" });
    s.clearSelection();
    expect(useFleet.getState().panel.kind).toBe("none");
    // snapshot replacement prunes stale selection
    s.select(["a", "zzz"]);
    s.applySnapshot(snapshot());
    expect(useFleet.getState().selection).toEqual(["a"]);
  });

  it("focus requests increment", () => {
    const s = useFleet.getState();
    s.focusUnit("a");
    const seq = useFleet.getState().focus?.seq;
    s.focusUnit("a");
    expect(useFleet.getState().focus?.seq).toBe((seq ?? 0) + 1);
  });
});
