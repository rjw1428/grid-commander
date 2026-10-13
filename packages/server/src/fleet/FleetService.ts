import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  UNIT_TYPE_BY_ID,
  hexKey,
  hexNeighbors,
  type CreateProjectBody,
  type CreateTeamBody,
  type CreateUnitBody,
  type FleetConfig,
  type Hex,
  type PatchProjectBody,
  type PatchTeamBody,
  type PatchUnitBody,
  type Project,
  type Team,
  type Unit,
} from "@gridcommander/shared";
import { nanoid } from "nanoid";
import type { Bus } from "../bus.js";
import { badRequest, conflict, notFound } from "../errors.js";
import type { Stores } from "../store/stores.js";
import type { RuntimeLogger } from "../runtime/UnitRuntime.js";

export interface FleetServiceDeps {
  stores: Stores;
  bus: Bus;
  /** fleet.json path for write-back; omit to disable. */
  configPath?: string;
  log: RuntimeLogger;
  /** cwd for projects with an empty cwd (hq). */
  fleetRoot: string;
  writeBackDebounceMs?: number;
}

function unitTypeOrThrow(id: string) {
  const t = UNIT_TYPE_BY_ID.get(id);
  if (!t) throw badRequest(`unknown unit type "${id}"`, "unknown_type");
  return t;
}

const PALETTE: { tint: string; flag: string }[] = [
  { tint: "#2d4a63", flag: "#6fb3f0" },
  { tint: "#2f4a36", flag: "#7fd68a" },
  { tint: "#4a2f4d", flag: "#d78ae0" },
  { tint: "#4a3a1e", flag: "#e9c46a" },
  { tint: "#4a2b2b", flag: "#f08a7a" },
  { tint: "#1f4a4a", flag: "#6fe0d6" },
  { tint: "#3f3f52", flag: "#b4b4f0" },
  { tint: "#4a4320", flag: "#dcd36a" },
];

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || nanoid(6).toLowerCase();

export class FleetService {
  readonly projects = new Map<string, Project>();
  readonly teams = new Map<string, Team>();
  readonly units = new Map<string, Unit>();
  #deps: FleetServiceDeps;
  #writeTimer: NodeJS.Timeout | null = null;

  constructor(deps: FleetServiceDeps) {
    this.#deps = deps;
  }

  // --------------------------------------------------------------------- load / boot

  /**
   * Merge fleet.json with the DB. For entities in both, fleet.json wins for structure; the DB wins
   * for session_id, status_since, lastResult and other runtime-derived fields. Entities only in the
   * DB are kept. All units come up `offline`; those that were mid-turn are reported by the caller.
   */
  load(cfg: FleetConfig): { wasWorking: Unit[] } {
    const { stores } = this.#deps;
    const dbProjects = new Map(stores.projects.all().map((p) => [p.id, p]));
    const dbTeams = new Map(stores.teams.all().map((t) => [t.id, t]));
    const dbUnits = new Map(stores.units.all().map((u) => [u.id, u]));

    for (const p of cfg.projects) {
      this.projects.set(p.id, { ...dbProjects.get(p.id), ...p });
      dbProjects.delete(p.id);
    }
    for (const p of dbProjects.values()) this.projects.set(p.id, p);

    const now = Date.now();
    for (const t of cfg.teams) {
      const prev = dbTeams.get(t.id);
      this.teams.set(t.id, { createdAt: prev?.createdAt ?? now, ...prev, ...t });
      dbTeams.delete(t.id);
    }
    for (const t of dbTeams.values()) this.teams.set(t.id, t);

    const wasWorking: Unit[] = [];
    for (const uc of cfg.units) {
      const prev = dbUnits.get(uc.id);
      const type = UNIT_TYPE_BY_ID.get(uc.type);
      const project = this.projects.get(uc.projectId);
      if (!type) {
        this.#deps.log.warn({ unitId: uc.id, type: uc.type }, "unit has unknown type; skipped");
        continue;
      }
      if (!project) {
        this.#deps.log.warn({ unitId: uc.id, projectId: uc.projectId }, "unit references unknown project; skipped");
        continue;
      }
      const hex = uc.hex ?? prev?.hex ?? this.#firstFreeHex(project, uc.id);
      if (!hex) {
        this.#deps.log.warn({ unitId: uc.id }, "no free hex for unit; skipped");
        continue;
      }
      const teamId = uc.teamId ?? [...this.teams.values()].find((t) => t.memberIds.includes(uc.id))?.id ?? prev?.teamId;
      const unit: Unit = {
        id: uc.id,
        name: uc.name,
        type: uc.type,
        projectId: uc.projectId,
        ...(teamId ? { teamId } : {}),
        hex,
        task: uc.task ?? prev?.task ?? "",
        status: "offline",
        statusSince: prev?.statusSince ?? now,
        model: uc.model ?? prev?.model ?? project.defaults?.model ?? type.model,
        permissionMode: uc.permissionMode ?? prev?.permissionMode ?? project.defaults?.permissionMode ?? type.defaultPermissionMode,
        queueLength: 0,
        unreadInbox: 0,
        ...(prev?.sessionId ? { sessionId: prev.sessionId } : {}),
        ...(prev?.lastResult ? { lastResult: prev.lastResult } : {}),
        ...(prev?.missionDone ? { missionDone: true } : {}),
        autostart: uc.autostart,
        createdAt: prev?.createdAt ?? now,
      };
      if (prev && (prev.status === "working" || prev.status === "waiting")) wasWorking.push(unit);
      this.units.set(unit.id, unit);
      dbUnits.delete(uc.id);
    }
    for (const prev of dbUnits.values()) {
      if (!this.projects.has(prev.projectId)) continue;
      if (prev.status === "working" || prev.status === "waiting") wasWorking.push(prev);
      const { pendingPermission: _pp, pendingQuestion: _pq, activity: _a, ...rest } = prev;
      this.units.set(prev.id, { ...rest, status: "offline", queueLength: 0, unreadInbox: 0 });
    }

    // team membership is authoritative on the team, mirror it to units
    for (const t of this.teams.values()) {
      t.memberIds = t.memberIds.filter((id) => this.units.has(id));
      for (const id of t.memberIds) {
        const u = this.units.get(id);
        if (u) u.teamId = t.id;
      }
    }

    for (const p of this.projects.values()) stores.projects.upsert(p);
    for (const t of this.teams.values()) stores.teams.upsert(t);
    for (const u of this.units.values()) stores.units.upsert(u);
    return { wasWorking };
  }

  // --------------------------------------------------------------------- queries

  getProject(id: string): Project {
    const p = this.projects.get(id);
    if (!p) throw notFound("project", id);
    return p;
  }
  getTeam(id: string): Team {
    const t = this.teams.get(id);
    if (!t) throw notFound("team", id);
    return t;
  }
  getUnit(id: string): Unit {
    const u = this.units.get(id);
    if (!u) throw notFound("unit", id);
    return u;
  }
  projectCwd(project: Project): string {
    return project.cwd ? resolve(project.cwd) : this.#deps.fleetRoot;
  }
  unitsIn(projectId: string): Unit[] {
    return [...this.units.values()].filter((u) => u.projectId === projectId);
  }
  occupant(hex: Hex, exceptUnitId?: string): Unit | undefined {
    return [...this.units.values()].find((u) => hexKey(u.hex) === hexKey(hex) && u.id !== exceptUnitId);
  }
  freeHexes(project: Project): Hex[] {
    const occupied = new Set([...this.units.values()].map((u) => hexKey(u.hex)));
    return project.cells.filter((c) => !occupied.has(hexKey(c)));
  }
  hasHq(): boolean {
    return this.projects.has("hq");
  }

  // --------------------------------------------------------------------- units

  createUnit(body: CreateUnitBody): Unit {
    const project = this.getProject(body.projectId);
    const type = unitTypeOrThrow(body.type);
    if ([...this.units.values()].some((u) => u.name === body.name)) throw conflict("name_taken", `unit name "${body.name}" already exists`);
    const id = body.id ?? slugify(body.name);
    if (this.units.has(id)) throw conflict("id_taken", `unit id "${id}" already exists`);
    const hex = this.#resolveHex(project, body.hex);
    if (body.teamId) this.getTeam(body.teamId);
    const now = Date.now();
    const unit: Unit = {
      id,
      name: body.name,
      type: type.id,
      projectId: project.id,
      ...(body.teamId ? { teamId: body.teamId } : {}),
      hex,
      task: body.task ?? "",
      status: "offline",
      statusSince: now,
      model: body.model ?? project.defaults?.model ?? type.model,
      permissionMode: body.permissionMode ?? project.defaults?.permissionMode ?? type.defaultPermissionMode,
      queueLength: 0,
      unreadInbox: 0,
      createdAt: now,
    };
    this.units.set(id, unit);
    if (body.teamId) {
      const team = this.getTeam(body.teamId);
      if (!team.memberIds.includes(id)) this.#saveTeam({ ...team, memberIds: [...team.memberIds, id] });
    }
    this.#saveUnit(unit);
    this.#scheduleWriteBack();
    return unit;
  }

  /** Structural patch from the operator (name, task, hex, project, team, model, permission mode). */
  patchUnit(id: string, body: PatchUnitBody): Unit {
    const unit = this.getUnit(id);
    const next: Unit = { ...unit };
    if (body.name !== undefined && body.name !== unit.name) {
      if ([...this.units.values()].some((u) => u.name === body.name && u.id !== id)) throw conflict("name_taken", `unit name "${body.name}" already exists`);
      next.name = body.name;
    }
    if (body.task !== undefined) {
      next.task = body.task;
      if (body.task !== unit.task) delete next.missionDone;
    }
    if (body.projectId !== undefined || body.hex !== undefined) {
      const project = this.getProject(body.projectId ?? unit.projectId);
      next.projectId = project.id;
      if (body.hex) {
        next.hex = this.#resolveHex(project, body.hex, id);
      } else if (project.id !== unit.projectId) {
        next.hex = this.#resolveHex(project, undefined, id);
      }
    }
    if (body.teamId !== undefined) {
      if (body.teamId === null) {
        if (unit.teamId) {
          const t = this.teams.get(unit.teamId);
          if (t) this.#saveTeam({ ...t, memberIds: t.memberIds.filter((m) => m !== id) });
        }
        delete next.teamId;
      } else {
        const team = this.getTeam(body.teamId);
        if (unit.teamId && unit.teamId !== team.id) {
          const old = this.teams.get(unit.teamId);
          if (old) this.#saveTeam({ ...old, memberIds: old.memberIds.filter((m) => m !== id) });
        }
        if (!team.memberIds.includes(id)) this.#saveTeam({ ...team, memberIds: [...team.memberIds, id] });
        next.teamId = team.id;
      }
    }
    if (body.model !== undefined) next.model = body.model;
    if (body.permissionMode !== undefined) next.permissionMode = body.permissionMode;
    if (body.autostart !== undefined) next.autostart = body.autostart;
    this.units.set(id, next);
    this.#saveUnit(next);
    this.#scheduleWriteBack();
    return next;
  }

  /** Runtime-derived patch (status, activity, sessionId...). `undefined` deletes the key. No write-back. */
  updateUnit(id: string, patch: Partial<Unit>): Unit {
    const unit = this.getUnit(id);
    const next = { ...unit } as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (v === undefined) delete next[k];
      else next[k] = v;
    }
    const u = next as Unit;
    this.units.set(id, u);
    this.#saveUnit(u);
    return u;
  }

  deleteUnit(id: string): void {
    const unit = this.getUnit(id);
    this.units.delete(id);
    if (unit.teamId) {
      const t = this.teams.get(unit.teamId);
      if (t) this.#saveTeam({ ...t, memberIds: t.memberIds.filter((m) => m !== id) });
    }
    this.#deps.stores.units.remove(id);
    this.#deps.bus.publish({ type: "unit.remove", id });
    this.#scheduleWriteBack();
  }

  // --------------------------------------------------------------------- projects

  createProject(body: CreateProjectBody): Project {
    const id = body.id ?? slugify(body.name);
    if (this.projects.has(id)) throw conflict("id_taken", `project id "${id}" already exists`);
    const palette = PALETTE[this.projects.size % PALETTE.length]!;
    const cells = body.cells?.length ? body.cells : this.#allocateTerritory(7);
    this.#assertCellsFree(cells, id);
    const project: Project = {
      id,
      name: body.name,
      cwd: body.cwd,
      tint: body.tint ?? palette.tint,
      flag: body.flag ?? palette.flag,
      cells,
      ...(body.defaults ? { defaults: body.defaults } : {}),
    };
    this.projects.set(id, project);
    this.#saveProject(project);
    this.#scheduleWriteBack();
    return project;
  }

  patchProject(id: string, body: PatchProjectBody): Project {
    const project = this.getProject(id);
    const next: Project = { ...project, ...stripUndefined(body) } as Project;
    if (body.cells) {
      this.#assertCellsFree(body.cells, id);
      const keep = new Set(body.cells.map(hexKey));
      const stranded = this.unitsIn(id).filter((u) => !keep.has(hexKey(u.hex)));
      if (stranded.length) throw conflict("hex_occupied", `cells still occupied by: ${stranded.map((u) => u.name).join(", ")}`);
    }
    this.projects.set(id, next);
    this.#saveProject(next);
    this.#scheduleWriteBack();
    return next;
  }

  deleteProject(id: string): void {
    this.getProject(id);
    const units = this.unitsIn(id);
    if (units.length) throw conflict("project_not_empty", `project has ${units.length} unit(s); remove them first`);
    this.projects.delete(id);
    this.#deps.stores.projects.remove(id);
    this.#deps.bus.publish({ type: "project.remove", id });
    this.#scheduleWriteBack();
  }

  // --------------------------------------------------------------------- teams

  createTeam(body: CreateTeamBody): Team {
    const id = body.id ?? slugify(body.name);
    if (this.teams.has(id)) throw conflict("id_taken", `team id "${id}" already exists`);
    for (const m of body.memberIds) this.getUnit(m);
    const team: Team = {
      id,
      name: body.name,
      color: body.color ?? PALETTE[(this.teams.size + 3) % PALETTE.length]!.flag,
      memberIds: [...new Set(body.memberIds)],
      createdAt: Date.now(),
    };
    this.teams.set(id, team);
    this.#applyMembership(team, []);
    this.#saveTeam(team);
    this.#scheduleWriteBack();
    return team;
  }

  patchTeam(id: string, body: PatchTeamBody): Team {
    const team = this.getTeam(id);
    if (body.memberIds) for (const m of body.memberIds) this.getUnit(m);
    const next: Team = { ...team, ...stripUndefined(body), memberIds: body.memberIds ? [...new Set(body.memberIds)] : team.memberIds } as Team;
    this.teams.set(id, next);
    this.#applyMembership(next, team.memberIds);
    this.#saveTeam(next);
    this.#scheduleWriteBack();
    return next;
  }

  deleteTeam(id: string): void {
    const team = this.getTeam(id);
    this.teams.delete(id);
    for (const m of team.memberIds) {
      const u = this.units.get(m);
      if (u && u.teamId === id) this.updateUnit(m, { teamId: undefined });
    }
    this.#deps.stores.teams.remove(id);
    this.#deps.bus.publish({ type: "team.remove", id });
    this.#scheduleWriteBack();
    for (const m of team.memberIds) {
      const u = this.units.get(m);
      if (u) this.#deps.bus.publish({ type: "unit.upsert", unit: u });
    }
  }

  // --------------------------------------------------------------------- write-back

  toConfig(): FleetConfig {
    return {
      projects: [...this.projects.values()],
      teams: [...this.teams.values()].map(({ id, name, color, memberIds }) => ({ id, name, color, memberIds })),
      units: [...this.units.values()].map((u) => ({
        id: u.id,
        name: u.name,
        type: u.type,
        projectId: u.projectId,
        ...(u.teamId ? { teamId: u.teamId } : {}),
        hex: u.hex,
        task: u.task,
        model: u.model,
        permissionMode: u.permissionMode,
        autostart: u.autostart ?? false,
      })),
    };
  }

  writeBackNow(): void {
    const path = this.#deps.configPath;
    if (!path) return;
    const abs = resolve(path);
    mkdirSync(dirname(abs), { recursive: true });
    const tmp = `${abs}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.toConfig(), null, 2) + "\n");
    renameSync(tmp, abs);
    this.#deps.log.debug({ path: abs }, "fleet.json written");
  }

  flush(): void {
    if (this.#writeTimer) {
      clearTimeout(this.#writeTimer);
      this.#writeTimer = null;
      this.writeBackNow();
    }
  }

  #scheduleWriteBack(): void {
    if (!this.#deps.configPath) return;
    if (this.#writeTimer) clearTimeout(this.#writeTimer);
    this.#writeTimer = setTimeout(() => {
      this.#writeTimer = null;
      try {
        this.writeBackNow();
      } catch (err) {
        this.#deps.log.error({ err }, "fleet.json write-back failed");
      }
    }, this.#deps.writeBackDebounceMs ?? 200);
  }

  // --------------------------------------------------------------------- internals

  #saveUnit(u: Unit): void {
    this.#deps.stores.units.upsert(u);
    this.#deps.bus.publish({ type: "unit.upsert", unit: u });
  }
  #saveProject(p: Project): void {
    this.#deps.stores.projects.upsert(p);
    this.#deps.bus.publish({ type: "project.upsert", project: p });
  }
  #saveTeam(t: Team): void {
    this.teams.set(t.id, t);
    this.#deps.stores.teams.upsert(t);
    this.#deps.bus.publish({ type: "team.upsert", team: t });
  }

  #applyMembership(team: Team, previous: string[]): void {
    for (const m of previous) {
      if (!team.memberIds.includes(m)) {
        const u = this.units.get(m);
        if (u && u.teamId === team.id) this.#saveUnit(this.updateUnit(m, { teamId: undefined }));
      }
    }
    for (const m of team.memberIds) {
      const u = this.units.get(m);
      if (!u) continue;
      if (u.teamId && u.teamId !== team.id) {
        const other = this.teams.get(u.teamId);
        if (other) this.#saveTeam({ ...other, memberIds: other.memberIds.filter((x) => x !== m) });
      }
      if (u.teamId !== team.id) this.#saveUnit(this.updateUnit(m, { teamId: team.id }));
    }
  }

  #resolveHex(project: Project, hex: Hex | undefined, exceptUnitId?: string): Hex {
    if (hex) {
      if (!project.cells.some((c) => hexKey(c) === hexKey(hex))) throw badRequest(`hex ${hexKey(hex)} is not in project "${project.id}"`, "hex_outside_project");
      const occ = this.occupant(hex, exceptUnitId);
      if (occ) throw conflict("hex_occupied", `hex ${hexKey(hex)} is occupied by ${occ.name}`);
      return hex;
    }
    const free = this.#firstFreeHex(project, exceptUnitId);
    if (!free) throw conflict("project_full", `project "${project.id}" has no free hex`);
    return free;
  }

  #firstFreeHex(project: Project, exceptUnitId?: string): Hex | undefined {
    const occupied = new Set([...this.units.values()].filter((u) => u.id !== exceptUnitId).map((u) => hexKey(u.hex)));
    return project.cells.find((c) => !occupied.has(hexKey(c)));
  }

  #allCells(exceptProjectId?: string): Set<string> {
    const s = new Set<string>();
    for (const p of this.projects.values()) if (p.id !== exceptProjectId) for (const c of p.cells) s.add(hexKey(c));
    return s;
  }

  #assertCellsFree(cells: Hex[], projectId: string): void {
    const taken = this.#allCells(projectId);
    const clash = cells.find((c) => taken.has(hexKey(c)));
    if (clash) throw conflict("cell_taken", `hex ${hexKey(clash)} belongs to another project`);
  }

  /** A compact 7-hex cluster (centre + ring) in free space, searched outward from the origin. */
  #allocateTerritory(size: number): Hex[] {
    const taken = this.#allCells();
    const spiral = hexSpiral(60);
    for (const centre of spiral) {
      const cluster = [centre, ...hexNeighbors(centre)].slice(0, size);
      // keep one hex of water between territories
      const halo = new Set<string>();
      for (const c of cluster) for (const n of hexNeighbors(c)) halo.add(hexKey(n));
      if (cluster.every((c) => !taken.has(hexKey(c))) && [...halo].every((k) => !taken.has(k))) return cluster;
    }
    throw conflict("map_full", "no free territory left on the map");
  }
}

function stripUndefined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Hexes in rings of increasing radius around the origin. */
export function hexSpiral(maxRadius: number): Hex[] {
  const out: Hex[] = [[0, 0]];
  for (let r = 1; r <= maxRadius; r++) {
    // start at the (-r, r) corner and walk the six edges
    let q = -r;
    let rr = r;
    const dirs: Hex[] = [
      [1, 0],
      [1, -1],
      [0, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
    ];
    for (const [dq, dr] of dirs) {
      for (let i = 0; i < r; i++) {
        out.push([q, rr]);
        q += dq;
        rr += dr;
      }
    }
  }
  return out;
}
