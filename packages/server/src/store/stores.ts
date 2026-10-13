import type {
  Alert,
  Message,
  MessageTarget,
  Order,
  Project,
  Settings,
  Team,
  TranscriptEntry,
  Unit,
} from "@gridcommander/shared";
import { SettingsSchema } from "@gridcommander/shared";
import type { Db } from "./db.js";

const parse = <T>(s: string): T => JSON.parse(s) as T;

// ----------------------------------------------------------------------------- projects / teams

export class ProjectStore {
  constructor(private db: Db) {}
  all(): Project[] {
    return (this.db.prepare(`SELECT json FROM projects ORDER BY id`).all() as { json: string }[]).map((r) =>
      parse<Project>(r.json),
    );
  }
  upsert(p: Project): void {
    this.db
      .prepare(`INSERT INTO projects (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
      .run(p.id, JSON.stringify(p), Date.now());
  }
  remove(id: string): void {
    this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
  }
}

export class TeamStore {
  constructor(private db: Db) {}
  all(): Team[] {
    return (this.db.prepare(`SELECT json FROM teams ORDER BY id`).all() as { json: string }[]).map((r) =>
      parse<Team>(r.json),
    );
  }
  upsert(t: Team): void {
    this.db
      .prepare(`INSERT INTO teams (id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`)
      .run(t.id, JSON.stringify(t), Date.now());
  }
  remove(id: string): void {
    this.db.prepare(`DELETE FROM teams WHERE id = ?`).run(id);
  }
}

// ----------------------------------------------------------------------------- units

export class UnitStore {
  constructor(private db: Db) {}
  all(): Unit[] {
    return (this.db.prepare(`SELECT json FROM units ORDER BY id`).all() as { json: string }[]).map((r) =>
      parse<Unit>(r.json),
    );
  }
  get(id: string): Unit | undefined {
    const row = this.db.prepare(`SELECT json FROM units WHERE id = ?`).get(id) as { json: string } | undefined;
    return row ? parse<Unit>(row.json) : undefined;
  }
  upsert(u: Unit): void {
    this.db
      .prepare(
        `INSERT INTO units (id, project_id, session_id, status, status_since, json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET project_id = excluded.project_id, session_id = excluded.session_id, status = excluded.status,
           status_since = excluded.status_since, json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(u.id, u.projectId, u.sessionId ?? null, u.status, u.statusSince, JSON.stringify(u), Date.now());
  }
  remove(id: string): void {
    this.db.prepare(`DELETE FROM units WHERE id = ?`).run(id);
  }
}

// ----------------------------------------------------------------------------- orders

interface OrderRow {
  id: string;
  unit_id: string;
  text: string;
  source: Order["source"];
  created_at: number;
  submitted_at: number | null;
  turn_id: string | null;
  position: number;
}

const rowToOrder = (r: OrderRow): Order => ({
  id: r.id,
  unitId: r.unit_id,
  text: r.text,
  source: r.source,
  createdAt: r.created_at,
  ...(r.submitted_at != null ? { submittedAt: r.submitted_at } : {}),
  ...(r.turn_id ? { turnId: r.turn_id } : {}),
});

export class OrderStore {
  constructor(private db: Db) {}
  insert(o: Order, position = 0): void {
    this.db
      .prepare(`INSERT INTO orders (id, unit_id, text, source, created_at, submitted_at, turn_id, position) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.id, o.unitId, o.text, o.source, o.createdAt, o.submittedAt ?? null, o.turnId ?? null, position);
  }
  pending(unitId: string): Order[] {
    return (
      this.db
        .prepare(`SELECT * FROM orders WHERE unit_id = ? AND submitted_at IS NULL ORDER BY position ASC, created_at ASC`)
        .all(unitId) as OrderRow[]
    ).map(rowToOrder);
  }
  pendingAll(): Order[] {
    return (
      this.db.prepare(`SELECT * FROM orders WHERE submitted_at IS NULL ORDER BY unit_id, position ASC, created_at ASC`).all() as OrderRow[]
    ).map(rowToOrder);
  }
  minPosition(unitId: string): number {
    const r = this.db.prepare(`SELECT MIN(position) AS m FROM orders WHERE unit_id = ? AND submitted_at IS NULL`).get(unitId) as { m: number | null };
    return r.m ?? 0;
  }
  markSubmitted(id: string, at: number): void {
    this.db.prepare(`UPDATE orders SET submitted_at = ? WHERE id = ?`).run(at, id);
  }
  remove(id: string): boolean {
    return this.db.prepare(`DELETE FROM orders WHERE id = ? AND submitted_at IS NULL`).run(id).changes > 0;
  }
  removeForUnit(unitId: string): void {
    this.db.prepare(`DELETE FROM orders WHERE unit_id = ?`).run(unitId);
  }
}

// ----------------------------------------------------------------------------- messages

interface MessageRow {
  id: string;
  from_id: string;
  to_json: string;
  body: string;
  priority: Message["priority"];
  thread_id: string;
  reply_to: string | null;
  relayed_from: string | null;
  created_at: number;
}
interface DeliveryRow {
  message_id: string;
  unit_id: string;
  delivered_at: number | null;
  read_at: number | null;
  how: "turn" | "interrupt" | "tool" | null;
}

export class MessageStore {
  constructor(private db: Db) {}

  insert(m: Message): void {
    this.db.transaction(() => {
      this.db
        .prepare(`INSERT INTO messages (id, from_id, to_json, body, priority, thread_id, reply_to, relayed_from, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(m.id, m.from, JSON.stringify(m.to), m.body, m.priority, m.threadId, m.replyTo ?? null, m.relayedFrom ?? null, m.createdAt);
      const ins = this.db.prepare(`INSERT INTO message_deliveries (message_id, unit_id, delivered_at, read_at, how) VALUES (?, ?, ?, ?, ?)`);
      for (const [unitId, d] of Object.entries(m.deliveries)) {
        ins.run(m.id, unitId, d.deliveredAt ?? null, d.readAt ?? null, d.how ?? null);
      }
    })();
  }

  markDelivered(messageId: string, unitId: string, how: "turn" | "interrupt" | "tool", at: number, read = how === "tool"): void {
    this.db
      .prepare(`UPDATE message_deliveries SET delivered_at = COALESCE(delivered_at, ?), how = ?, read_at = CASE WHEN ? THEN COALESCE(read_at, ?) ELSE read_at END WHERE message_id = ? AND unit_id = ?`)
      .run(at, how, read ? 1 : 0, at, messageId, unitId);
  }

  markRead(messageId: string, unitId: string, at: number): void {
    this.db.prepare(`UPDATE message_deliveries SET read_at = COALESCE(read_at, ?) WHERE message_id = ? AND unit_id = ?`).run(at, messageId, unitId);
  }

  get(id: string): Message | undefined {
    const row = this.db.prepare(`SELECT * FROM messages WHERE id = ?`).get(id) as MessageRow | undefined;
    return row ? this.#hydrate([row])[0] : undefined;
  }

  /** Messages for a unit's inbox that have not been read (delivered-by-turn still counts as read for the inbox). */
  unreadFor(unitId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN message_deliveries d ON d.message_id = m.id
         WHERE d.unit_id = ? AND d.read_at IS NULL ORDER BY m.created_at ASC`,
      )
      .all(unitId) as MessageRow[];
    return this.#hydrate(rows);
  }

  undeliveredFor(unitId: string): Message[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM messages m JOIN message_deliveries d ON d.message_id = m.id
         WHERE d.unit_id = ? AND d.delivered_at IS NULL AND d.read_at IS NULL ORDER BY m.created_at ASC`,
      )
      .all(unitId) as MessageRow[];
    return this.#hydrate(rows);
  }

  unreadCount(unitId: string): number {
    const r = this.db.prepare(`SELECT COUNT(*) AS n FROM message_deliveries WHERE unit_id = ? AND read_at IS NULL`).get(unitId) as { n: number };
    return r.n;
  }

  query(opts: { threadId?: string; unitId?: string; limit: number }): Message[] {
    let rows: MessageRow[];
    if (opts.threadId) {
      rows = this.db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC LIMIT ?`).all(opts.threadId, opts.limit) as MessageRow[];
    } else if (opts.unitId) {
      rows = this.db
        .prepare(
          `SELECT DISTINCT m.* FROM messages m LEFT JOIN message_deliveries d ON d.message_id = m.id
           WHERE m.from_id = ? OR d.unit_id = ? OR m.relayed_from = ? ORDER BY m.created_at DESC LIMIT ?`,
        )
        .all(opts.unitId, opts.unitId, opts.unitId, opts.limit) as MessageRow[];
      rows.reverse();
    } else {
      rows = this.db.prepare(`SELECT * FROM messages ORDER BY created_at DESC LIMIT ?`).all(opts.limit) as MessageRow[];
      rows.reverse();
    }
    return this.#hydrate(rows);
  }

  #hydrate(rows: MessageRow[]): Message[] {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const deliveries = this.db
      .prepare(`SELECT * FROM message_deliveries WHERE message_id IN (${placeholders})`)
      .all(...ids) as DeliveryRow[];
    const byMsg = new Map<string, Message["deliveries"]>();
    for (const d of deliveries) {
      const m = byMsg.get(d.message_id) ?? {};
      m[d.unit_id] = {
        ...(d.delivered_at != null ? { deliveredAt: d.delivered_at } : {}),
        ...(d.read_at != null ? { readAt: d.read_at } : {}),
        ...(d.how ? { how: d.how } : {}),
      };
      byMsg.set(d.message_id, m);
    }
    return rows.map((r) => ({
      id: r.id,
      from: r.from_id,
      to: parse<MessageTarget>(r.to_json),
      body: r.body,
      priority: r.priority,
      threadId: r.thread_id,
      ...(r.reply_to ? { replyTo: r.reply_to } : {}),
      ...(r.relayed_from ? { relayedFrom: r.relayed_from } : {}),
      createdAt: r.created_at,
      deliveries: byMsg.get(r.id) ?? {},
    }));
  }
}

// ----------------------------------------------------------------------------- transcript

export class TranscriptStore {
  constructor(private db: Db) {}
  append(unitId: string, entries: TranscriptEntry[]): void {
    const ins = this.db.prepare(`INSERT INTO transcript (unit_id, at, kind, tool_use_id, json) VALUES (?, ?, ?, ?, ?)`);
    this.db.transaction(() => {
      for (const e of entries) {
        ins.run(unitId, e.at, e.kind, e.kind === "tool" ? (e.toolUseId ?? null) : null, JSON.stringify(e));
      }
    })();
  }
  updateTool(unitId: string, toolUseId: string, patch: { ok?: boolean; durationMs?: number }): TranscriptEntry | undefined {
    const row = this.db.prepare(`SELECT seq, json FROM transcript WHERE unit_id = ? AND tool_use_id = ? ORDER BY seq DESC LIMIT 1`).get(unitId, toolUseId) as
      | { seq: number; json: string }
      | undefined;
    if (!row) return undefined;
    const entry = { ...parse<TranscriptEntry>(row.json), ...patch } as TranscriptEntry;
    this.db.prepare(`UPDATE transcript SET json = ? WHERE seq = ?`).run(JSON.stringify(entry), row.seq);
    return entry;
  }
  /** Newest `limit` entries strictly before `before` (epoch ms), returned oldest first. */
  list(unitId: string, opts: { before?: number; limit: number }): TranscriptEntry[] {
    const rows = (
      opts.before != null
        ? this.db.prepare(`SELECT json FROM transcript WHERE unit_id = ? AND at < ? ORDER BY at DESC, seq DESC LIMIT ?`).all(unitId, opts.before, opts.limit)
        : this.db.prepare(`SELECT json FROM transcript WHERE unit_id = ? ORDER BY at DESC, seq DESC LIMIT ?`).all(unitId, opts.limit)
    ) as { json: string }[];
    return rows.map((r) => parse<TranscriptEntry>(r.json)).reverse();
  }
  prune(unitId: string, keep: number): number {
    return this.db
      .prepare(`DELETE FROM transcript WHERE unit_id = ? AND seq NOT IN (SELECT seq FROM transcript WHERE unit_id = ? ORDER BY seq DESC LIMIT ?)`)
      .run(unitId, unitId, keep).changes;
  }
  pruneAll(keep: number): number {
    const units = this.db.prepare(`SELECT DISTINCT unit_id FROM transcript`).all() as { unit_id: string }[];
    let n = 0;
    for (const u of units) n += this.prune(u.unit_id, keep);
    return n;
  }
  removeForUnit(unitId: string): void {
    this.db.prepare(`DELETE FROM transcript WHERE unit_id = ?`).run(unitId);
  }
}

// ----------------------------------------------------------------------------- alerts

export class AlertStore {
  constructor(private db: Db) {}
  open(): Alert[] {
    return (this.db.prepare(`SELECT json FROM alerts WHERE dismissed_at IS NULL ORDER BY created_at ASC`).all() as { json: string }[]).map((r) =>
      parse<Alert>(r.json),
    );
  }
  upsert(a: Alert): void {
    this.db
      .prepare(
        `INSERT INTO alerts (id, kind, unit_id, json, created_at, dismissed_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, unit_id = excluded.unit_id, json = excluded.json, created_at = excluded.created_at, dismissed_at = excluded.dismissed_at`,
      )
      .run(a.id, a.kind, a.unitId ?? null, JSON.stringify(a), a.createdAt, a.dismissedAt ?? null);
  }
  pruneDismissed(olderThanMs: number): number {
    return this.db.prepare(`DELETE FROM alerts WHERE dismissed_at IS NOT NULL AND dismissed_at < ?`).run(Date.now() - olderThanMs).changes;
  }
}

// ----------------------------------------------------------------------------- push subscriptions

export interface StoredPushSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

export class PushStore {
  constructor(private db: Db) {}
  all(): StoredPushSubscription[] {
    return (this.db.prepare(`SELECT json FROM push_subscriptions`).all() as { json: string }[]).map((r) => parse<StoredPushSubscription>(r.json));
  }
  upsert(s: StoredPushSubscription): void {
    this.db
      .prepare(`INSERT INTO push_subscriptions (endpoint, json, created_at) VALUES (?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json`)
      .run(s.endpoint, JSON.stringify(s), Date.now());
  }
  remove(endpoint: string): boolean {
    return this.db.prepare(`DELETE FROM push_subscriptions WHERE endpoint = ?`).run(endpoint).changes > 0;
  }
}

// ----------------------------------------------------------------------------- settings

export class SettingsStore {
  constructor(private db: Db) {}
  all(): Settings {
    const rows = this.db.prepare(`SELECT key, value FROM settings`).all() as { key: string; value: string }[];
    const raw: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        raw[r.key] = JSON.parse(r.value);
      } catch {
        /* ignore corrupt */
      }
    }
    return SettingsSchema.parse(raw);
  }
  set(patch: Partial<Settings>): Settings {
    const up = this.db.prepare(`INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`);
    this.db.transaction(() => {
      for (const [k, v] of Object.entries(patch)) if (v !== undefined) up.run(k, JSON.stringify(v));
    })();
    return this.all();
  }
}

export interface Stores {
  projects: ProjectStore;
  teams: TeamStore;
  units: UnitStore;
  orders: OrderStore;
  messages: MessageStore;
  transcript: TranscriptStore;
  alerts: AlertStore;
  push: PushStore;
  settings: SettingsStore;
}

export function createStores(db: Db): Stores {
  return {
    projects: new ProjectStore(db),
    teams: new TeamStore(db),
    units: new UnitStore(db),
    orders: new OrderStore(db),
    messages: new MessageStore(db),
    transcript: new TranscriptStore(db),
    alerts: new AlertStore(db),
    push: new PushStore(db),
    settings: new SettingsStore(db),
  };
}
