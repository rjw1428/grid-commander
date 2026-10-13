import { create } from "zustand";
import type {
  Alert,
  Message,
  Project,
  ServerInfo,
  Settings,
  Snapshot,
  Team,
  TranscriptEntry,
  Unit,
  UnitTypeDef,
  WsServerEvent,
} from "@hexcommand/shared";

export type Connection = "connecting" | "live" | "offline";
export type Mode = "idle" | "move" | "multi";
export type SheetMode = "closed" | "units" | "alerts" | "commands" | "detail";
export type PanelView =
  | { kind: "none" }
  | { kind: "unit"; id: string }
  | { kind: "group"; ids: string[] }
  | { kind: "project"; id: string }
  | { kind: "team"; id: string }
  | { kind: "legend" }
  | { kind: "recruit"; projectId?: string }
  | { kind: "settings" };

const RING = 500;

export interface FleetState {
  projects: Record<string, Project>;
  teams: Record<string, Team>;
  units: Record<string, Unit>;
  alerts: Record<string, Alert>;
  unitTypes: Record<string, UnitTypeDef>;
  settings: Settings | null;
  server: ServerInfo | null;
  transcripts: Record<string, TranscriptEntry[]>;
  messages: Message[];
  connection: Connection;
  hasSnapshot: boolean;
  selection: string[];
  hover: string | null;
  mode: Mode;
  sheet: SheetMode;
  panel: PanelView;
  /** incrementing request: the camera flies to this unit/hex */
  focus: { unitId?: string; projectId?: string; seq: number } | null;
  /** operator-local banner for mobile */
  banner: Alert | null;
  soundOn: boolean;

  applySnapshot: (s: Snapshot) => void;
  applyEvent: (e: WsServerEvent) => void;
  setConnection: (c: Connection) => void;
  select: (ids: string[], opts?: { panel?: boolean }) => void;
  toggleSelect: (id: string) => void;
  clearSelection: () => void;
  setHover: (id: string | null) => void;
  setMode: (m: Mode) => void;
  setSheet: (s: SheetMode) => void;
  setPanel: (p: PanelView) => void;
  focusUnit: (id: string) => void;
  focusProject: (id: string) => void;
  prependTranscript: (unitId: string, entries: TranscriptEntry[]) => void;
  setTranscript: (unitId: string, entries: TranscriptEntry[]) => void;
  setMessages: (m: Message[]) => void;
  setBanner: (a: Alert | null) => void;
  setSound: (on: boolean) => void;
}

const byId = <T extends { id: string }>(xs: T[]): Record<string, T> => Object.fromEntries(xs.map((x) => [x.id, x]));

export const useFleet = create<FleetState>((set, get) => ({
  projects: {},
  teams: {},
  units: {},
  alerts: {},
  unitTypes: {},
  settings: null,
  server: null,
  transcripts: {},
  messages: [],
  connection: "connecting",
  hasSnapshot: false,
  selection: [],
  hover: null,
  mode: "idle",
  sheet: "closed",
  panel: { kind: "none" },
  focus: null,
  banner: null,
  soundOn: false,

  applySnapshot: (s) =>
    set((st) => ({
      projects: byId(s.projects),
      teams: byId(s.teams),
      units: byId(s.units),
      alerts: byId(s.alerts),
      unitTypes: byId(s.unitTypes),
      settings: s.settings,
      server: s.server,
      hasSnapshot: true,
      selection: st.selection.filter((id) => s.units.some((u) => u.id === id)),
    })),

  applyEvent: (e) => {
    switch (e.type) {
      case "snapshot":
        get().applySnapshot(e.state);
        return;
      case "unit.upsert":
        set((st) => ({ units: { ...st.units, [e.unit.id]: e.unit } }));
        return;
      case "unit.remove":
        set((st) => {
          const units = { ...st.units };
          delete units[e.id];
          const transcripts = { ...st.transcripts };
          delete transcripts[e.id];
          return { units, transcripts, selection: st.selection.filter((x) => x !== e.id) };
        });
        return;
      case "unit.transcript":
        set((st) => {
          const prev = st.transcripts[e.unitId];
          if (!prev) return {}; // not loaded; REST fetch will bring the full tail
          const next = [...prev, ...e.entries];
          return { transcripts: { ...st.transcripts, [e.unitId]: next.length > RING ? next.slice(next.length - RING) : next } };
        });
        return;
      case "unit.transcriptUpdate":
        set((st) => {
          const prev = st.transcripts[e.unitId];
          if (!prev) return {};
          const idx = prev.findIndex((t) => t.kind === "tool" && t.toolUseId === e.toolUseId);
          if (idx < 0) return {};
          const next = prev.slice();
          const t = next[idx];
          if (t && t.kind === "tool") next[idx] = { ...t, ...(e.ok !== undefined ? { ok: e.ok } : {}), ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}) };
          return { transcripts: { ...st.transcripts, [e.unitId]: next } };
        });
        return;
      case "unit.permission":
      case "unit.question":
        return; // carried on unit.upsert too
      case "alert.upsert":
        set((st) => ({ alerts: { ...st.alerts, [e.alert.id]: e.alert }, banner: st.alerts[e.alert.id] ? st.banner : e.alert }));
        return;
      case "alert.remove":
        set((st) => {
          const alerts = { ...st.alerts };
          delete alerts[e.id];
          return { alerts, banner: st.banner?.id === e.id ? null : st.banner };
        });
        return;
      case "message.new":
        set((st) => ({ messages: [...st.messages.filter((m) => m.id !== e.message.id), e.message].slice(-500) }));
        return;
      case "project.upsert":
        set((st) => ({ projects: { ...st.projects, [e.project.id]: e.project } }));
        return;
      case "project.remove":
        set((st) => {
          const projects = { ...st.projects };
          delete projects[e.id];
          return { projects };
        });
        return;
      case "team.upsert":
        set((st) => ({ teams: { ...st.teams, [e.team.id]: e.team } }));
        return;
      case "team.remove":
        set((st) => {
          const teams = { ...st.teams };
          delete teams[e.id];
          return { teams };
        });
        return;
      case "settings.upsert":
        set((st) => ({ settings: { ...(st.settings ?? ({} as Settings)), ...(e.settings as Partial<Settings>) } as Settings }));
        return;
      case "server.info":
        set({ server: e.info });
        return;
      case "pong":
        return;
    }
  },

  setConnection: (connection) => set({ connection }),
  select: (ids, opts) =>
    set((st) => {
      const panel: PanelView = opts?.panel === false ? st.panel : ids.length === 0 ? { kind: "none" } : ids.length === 1 ? { kind: "unit", id: ids[0]! } : { kind: "group", ids };
      return { selection: ids, panel, sheet: ids.length && st.sheet === "closed" ? "detail" : st.sheet };
    }),
  toggleSelect: (id) => {
    const cur = get().selection;
    const next = cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id];
    get().select(next);
  },
  clearSelection: () => set({ selection: [], panel: { kind: "none" }, sheet: "closed" }),
  setHover: (hover) => set({ hover }),
  setMode: (mode) => set({ mode }),
  setSheet: (sheet) => set({ sheet }),
  setPanel: (panel) => set({ panel }),
  focusUnit: (unitId) => set((st) => ({ focus: { unitId, seq: (st.focus?.seq ?? 0) + 1 } })),
  focusProject: (projectId) => set((st) => ({ focus: { projectId, seq: (st.focus?.seq ?? 0) + 1 } })),
  prependTranscript: (unitId, entries) =>
    set((st) => ({ transcripts: { ...st.transcripts, [unitId]: [...entries, ...(st.transcripts[unitId] ?? [])] } })),
  setTranscript: (unitId, entries) => set((st) => ({ transcripts: { ...st.transcripts, [unitId]: entries.slice(-RING) } })),
  setMessages: (messages) => set({ messages }),
  setBanner: (banner) => set({ banner }),
  setSound: (soundOn) => set({ soundOn }),
}));

// ----------------------------------------------------------------------------- selectors

export const selectUnitList = (s: FleetState) => Object.values(s.units).sort((a, b) => a.projectId.localeCompare(b.projectId) || a.name.localeCompare(b.name));
export const selectOpenAlerts = (s: FleetState) => Object.values(s.alerts).sort((a, b) => b.createdAt - a.createdAt);
export const selectCounts = (s: FleetState) => {
  const units = Object.values(s.units);
  return {
    units: units.length,
    working: units.filter((u) => u.status === "working").length,
    waiting: units.filter((u) => u.status === "waiting").length,
    teams: Object.keys(s.teams).length,
  };
};
