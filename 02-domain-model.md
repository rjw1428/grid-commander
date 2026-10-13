# 02 — Domain model

All types live in `packages/shared/src/domain.ts` with matching zod schemas. Field names below are normative.

## Hex coordinates

Axial `[q, r]`, pointy-top hexes, exactly as the prototype: world x = √3·(q + r/2), world z = 1.5·r (times hex size). A hex is owned by at most one project. A unit occupies exactly one hex; two units never share a hex.

## Project

```ts
interface Project {
  id: string;            // slug, stable
  name: string;
  cwd: string;           // absolute repo/worktree root used as the SDK cwd for its units
  tint: string;          // hex colour of territory tiles, e.g. "#2d4a63"
  flag: string;          // bright project colour for armbands/plates/labels
  cells: [number, number][];  // owned hexes
  defaults?: { permissionMode?: PermissionMode; model?: string; appendSystemPrompt?: string };
}
```

An `hq` project with no `cwd` requirement is allowed (the General's seat); units in it run with `cwd` = the fleet root.

## Unit type

`packages/shared/unit-types.json`, validated at startup:

```ts
interface UnitTypeDef {
  id: string;          // "engineer" | "infantry" | "sniper" | "captain" | "major" | "general" | ...
  name: string;        // "Engineer"
  glyph: string;       // one letter for badges
  rank: string;        // "Corps of Engineers", "Rifleman", ...
  stars: 0 | 1 | 2 | 3;
  model: string;       // SDK model alias: "opus" | "sonnet" | "haiku" | full name
  color: string;       // type colour: cap band, chest patch, badges
  role: string;        // one-line description shown in legend
  systemPrompt: string;// appended to the Claude Code preset system prompt for this type
  rig: string;         // client rig id: "engineer" | "infantry" | "sniper" | "officer"
  props: string[];     // rig props: "clipboard","calculator","tripod","pickaxe","rifle","folder","radio","baton"
  workAnim: string;    // "survey" | "dig" | "sweep" | "paperwork" | "radio" | "bark"
  defaultPermissionMode: PermissionMode;
  commsScope: "project" | "team" | "fleet";  // widest audience this type may message without the operator
}
```

Ship the six types from the prototype. `general.commsScope = "fleet"`, `major.commsScope = "fleet"`, all others `"project"`.

## Unit

```ts
type UnitStatus = "offline" | "idle" | "working" | "waiting" | "done" | "error";

interface Unit {
  id: string;                 // slug, unique
  name: string;               // display, e.g. "xre-cache"
  type: string;               // UnitTypeDef.id
  projectId: string;
  teamId?: string;
  hex: [number, number];
  task: string;               // operator-set mission line; the unit may update it via fleet_report
  status: UnitStatus;
  statusSince: number;        // epoch ms
  activity?: string;          // short live line: "Bash: gradle test", "Editing Foo.java", "Thinking"
  sessionId?: string;         // SDK session id, for resume
  model: string;              // effective model (type default unless overridden)
  permissionMode: PermissionMode;
  queueLength: number;        // pending orders
  unreadInbox: number;        // undelivered messages
  pendingPermission?: PermissionRequest;   // when status === "waiting"
  lastResult?: { at: number; text: string; costUsd?: number; durationMs?: number };
  createdAt: number;
}
```

## Status machine

Status is derived on the server from runtime events. Transitions (source → target: cause):

| From | To | Cause |
|---|---|---|
| any | `offline` | SDK process exits or `stop` command; `sessionId` retained for resume |
| `offline` | `idle` | `start`/`resume` succeeds (`system/init` received) |
| `idle`/`done`/`error` | `working` | an order, a queued order, or an inbox delivery is submitted as a user turn |
| `working` | `waiting` | `canUseTool` invoked (permission), or assistant calls `AskUserQuestion`, or an MCP elicitation arrives |
| `waiting` | `working` | operator answers (allow/deny/answer) |
| `working` | `done` | `result` with `subtype: "success"` |
| `working` | `error` | `result` with error subtype, `StopFailure` hook, or process crash mid-turn |
| `done` | `idle` | operator acknowledges (opens the unit or clicks Ack) or sends the next order; auto after `FLEET_DONE_AUTOACK_MS` (default 10 min) |
| `error` | `idle` | operator acknowledges |
| `done`/`idle` | `working` | order queue non-empty → next order auto-submitted immediately on reaching `done`/`idle` |

`activity` is updated on every `assistant` message: `tool_use` block → `"<tool>: <short arg>"` (Bash: first 40 chars of command; Edit/Write/Read: basename; Grep/Glob: pattern; Agent: description); text block → `"Writing"`; thinking → `"Thinking"`. Cleared on `result`.

## Team

```ts
interface Team { id: string; name: string; color: string; memberIds: string[]; createdAt: number }
```

A unit belongs to at most one team. Deleting a team clears `teamId` on its members.

## Order

```ts
interface Order { id: string; unitId: string; text: string; source: "operator" | "broadcast" | "queue" | "inbox" | "urgent"; createdAt: number; submittedAt?: number; turnId?: string }
```

Orders are persisted. The queue is FIFO per unit. Submitting an order while the unit is `working` enqueues unless `interrupt: true` was requested, in which case the runtime calls `interrupt()`, waits for the interrupted `result`, then submits.

## Message (unit ↔ unit, operator → unit)

See `04-agent-comms.md` for semantics.

```ts
interface Message {
  id: string;
  from: string;                       // unit id or "operator"
  to: { kind: "unit"; id: string } | { kind: "team"; id: string } | { kind: "project"; id: string } | { kind: "fleet" };
  body: string;
  priority: "normal" | "urgent";
  threadId: string;                   // = id of first message in thread
  replyTo?: string;
  createdAt: number;
  deliveries: Record<string, { deliveredAt?: number; readAt?: number; how?: "turn" | "interrupt" | "tool" }>;  // per recipient unit
}
```

## Alert

```ts
type AlertKind = "waiting" | "error" | "done" | "idle" | "message" | "info";
interface Alert { id: string; kind: AlertKind; unitId?: string; title: string; body: string; createdAt: number; dismissedAt?: number; payload?: unknown }
```

Alerts collapse: a new alert with the same `(kind, unitId)` as an open one replaces it (keeps the original `id`, bumps `createdAt`). Alerts for a unit of kind `waiting`/`error`/`done`/`idle` auto-dismiss when that unit next transitions to `working`.

## Transcript entries (per unit, persisted)

```ts
type TranscriptEntry =
  | { kind: "user"; at: number; text: string; source: Order["source"] }
  | { kind: "assistant"; at: number; text: string }
  | { kind: "tool"; at: number; name: string; summary: string; ok?: boolean; durationMs?: number }
  | { kind: "result"; at: number; ok: boolean; text: string; costUsd?: number }
  | { kind: "message"; at: number; messageId: string; direction: "in" | "out" }
  | { kind: "system"; at: number; text: string };
```

The server keeps the last 500 entries per unit in memory and all in SQLite. Tool input/output bodies are not stored; summaries only. The full transcript is the SDK's own `.jsonl`.

## fleet.json

```json
{
  "projects": [ { "id": "xre", "name": "XRE Platform", "cwd": "/home/ryan/src/xre", "tint": "#2d4a63", "flag": "#6fb3f0", "cells": [[0,0],[1,0],[2,0],[0,1],[1,1]] } ],
  "teams":    [ { "id": "t1", "name": "XRE Cache Squad", "color": "#e07a3a", "memberIds": ["xre-plan","xre-cache"] } ],
  "units":    [ { "id": "xre-plan", "name": "xre-plan", "type": "engineer", "projectId": "xre", "hex": [0,0], "task": "Design cache invalidation", "autostart": true } ]
}
```

`autostart: true` units are started when the server boots (resumed if a `sessionId` is stored). Everything else starts `offline`.
