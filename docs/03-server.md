# 03 — Server

`packages/server`. Fastify, one process, TypeScript strict. Structure:

```
src/
  index.ts              # boot: load config, open db, start runtimes with autostart, listen
  config.ts             # env + fleet.json load/validate/write-back
  store/                # SQLite access (one module per table), migrations in store/migrations/*.sql
  runtime/
    UnitRuntime.ts      # wraps one Agent SDK query; the only file that imports the SDK
    Runtime.ts          # interface (start/stop/submit/interrupt/answerPermission/answerQuestion/events)
    statusMachine.ts    # pure function: (state, event) → state; unit-tested
    activity.ts         # SDKMessage → activity string; unit-tested
  comms/
    CommsBroker.ts      # routing, scope policy, delivery strategy
    fleetTools.ts       # createSdkMcpServer per unit (04-agent-comms.md)
    hooks.ts            # SDK hook callbacks (inbox nudge, stop capture)
  alerts/AlertEngine.ts # derive alerts, idle watchdog, web push
  api/
    rest.ts             # routes under /api
    ws.ts               # /ws: snapshot + deltas; fan-out
    auth.ts
  fleet/FleetService.ts # projects/teams/units CRUD, hex allocation, write-back to fleet.json
```

## Runtime: `UnitRuntime`

One instance per running unit. Uses `query({ prompt: <AsyncIterable<SDKUserMessage>>, options })` from `@anthropic-ai/claude-agent-sdk` in **streaming input mode** so the session lives across many turns and supports `interrupt()`, `setModel()`, `setPermissionMode()`.

Options per unit:

```ts
{
  cwd: project.cwd,
  model: unit.model,
  permissionMode: unit.permissionMode,           // default from type; operator can change live
  resume: unit.sessionId,                        // when resuming
  systemPrompt: { type: "preset", preset: "claude_code", append: buildUnitSystemPrompt(unit, type, project) },
  settingSources: ["user", "project", "local"],  // keep the repo's CLAUDE.md, hooks and MCP servers
  mcpServers: { fleet: fleetTools.forUnit(unit) }, // in-process SDK MCP server, see 04
  hooks: hooks.forUnit(unit),                    // PostToolUse inbox nudge, Stop capture, see 04
  canUseTool: (toolName, input, ctx) => permissionBridge.ask(unit, toolName, input, ctx),
  includePartialMessages: false,
  maxTurns: undefined,
}
```

`buildUnitSystemPrompt` states: the unit's name, rank, role and project; that other units exist and how to reach them (`fleet_*` tools); the etiquette in `04-agent-comms.md`; that `fleet_report` should be called when the mission line changes or a milestone is hit; that the operator may be on a phone, so final messages must lead with a one-line status.

Input side: an async generator fed by an internal queue. `submit(text, source)` pushes an `SDKUserMessage` and resolves when the corresponding `result` arrives (returns the result). Exactly one turn in flight at a time; the order queue lives above the runtime in `OrderService`.

Output side: iterate the `Query`; for each `SDKMessage` emit domain events:

| SDKMessage | Effect |
|---|---|
| `system` / `init` | status `idle`; store `session_id`; record model, tools, mcp server statuses (log failures of `fleet` server as `error` alert) |
| `assistant` | append transcript entries per content block; update `activity`; if a block is `tool_use` named `AskUserQuestion`, status `waiting` with `pendingQuestion` |
| `user` (tool results) | update tool entry ok/duration |
| `result` | status `done` or `error`; store `lastResult`; resolve the in-flight submit |
| `system` / `api_retry`, `rate_limit`, `status` | `activity` = humanised text; `info` alert on repeated retries (≥3) |
| `compact_boundary` | transcript `system` entry |

`canUseTool` → status `waiting` with `pendingPermission = { toolName, input (summarised), requestId, suggestions }`; returns a promise resolved by `answerPermission(unitId, { allow, updatedInput?, remember? })`. `remember` maps to the SDK's "always allow" suggestion when present. A `waiting` unit with no answer for `FLEET_PERMISSION_TIMEOUT_MS` (default: none) stays waiting; the operator decides.

`interrupt()` → `query.interrupt()`; the in-flight submit resolves with the interrupted result. Used by urgent delivery, "Halt", and `interrupt: true` orders.

`stop()` → `query.close()`; status `offline`; `sessionId` retained. `start()` with a stored `sessionId` passes `resume`.

Crash handling: if the generator throws or the process exits, status `error` (if a turn was in flight) or `offline`; emit alert; do not auto-restart (operator restarts; a `restartPolicy` can come later).

Runtime interface is abstract (`Runtime.ts`) so a `TmuxRuntime` adapter can be added later without touching services.

## Services (above the runtime)

- **OrderService**: per-unit FIFO. `enqueue(unitId, text, source, {interrupt?})`. Drains when unit is `idle`/`done`/`error`-acknowledged. Persists orders; marks `submittedAt`.
- **PermissionBridge**: holds pending permission promises; exposes answer; times out nothing.
- **CommsBroker**: `04-agent-comms.md`.
- **AlertEngine**: subscribes to status changes; idle watchdog every 15 s; Web Push on `waiting`, `error`, `done` (configurable per kind in settings), coalesced to at most one push per unit per minute.
- **FleetService**: create/update/delete projects, teams, units; allocate the first free hex in a project when none given; validate occupancy; write-back `fleet.json`.

## REST API (`/api`, JSON, bearer auth)

```
GET    /state                              → full snapshot (projects, teams, units, open alerts, unitTypes, server info)
GET    /units/:id/transcript?before=<at>&limit=200
GET    /units/:id/messages?limit=100

POST   /units                              { name, type, projectId, hex?, task?, model?, permissionMode?, firstOrder?, start?: true }
PATCH  /units/:id                          { name?, task?, hex?, projectId?, teamId?, model?, permissionMode? }   // model/permission applied live via setModel/setPermissionMode
DELETE /units/:id                          stops and removes (transcript kept)
POST   /units/:id/start | /stop | /interrupt | /ack
POST   /units/:id/orders                   { text, interrupt?: boolean }        → { orderId, queued: boolean }
DELETE /units/:id/orders/:orderId          remove a queued order
POST   /units/:id/permission               { allow: boolean, updatedInput?, remember?: boolean }
POST   /units/:id/answer                   { answers: Record<string,string> }  // AskUserQuestion
POST   /units/:id/compact                  submits "/compact" as an order

POST   /broadcast                          { to: {kind:"fleet"} | {kind:"team",id} | {kind:"project",id} | {kind:"units",ids[]}, text, queueIfBusy: boolean }
POST   /messages                           operator → unit(s): { to, body, priority }     (04)
GET    /messages?threadId=|unitId=

POST   /projects | PATCH /projects/:id | DELETE /projects/:id
POST   /teams    | PATCH /teams/:id    | DELETE /teams/:id        { name, color, memberIds }
POST   /alerts/:id/dismiss | POST /alerts/dismiss-all
GET    /push/vapid-public-key | POST /push/subscribe | DELETE /push/subscribe
GET    /health                             (no auth) { ok, version, units: n }
```

Errors: `{ error: { code, message } }` with 400/401/404/409 (hex occupied, name taken, max units) /500.

## WebSocket (`/ws?token=`)

Server → client, JSON, discriminated by `type`:

```
snapshot        { state }                      on connect and after reconnect
unit.upsert     { unit }                       any field change (status, activity, queueLength, hex, ...)
unit.remove     { id }
unit.transcript { unitId, entries: TranscriptEntry[] }   appended entries, batched ≤100 ms
unit.permission { unitId, request | null }
alert.upsert    { alert } | alert.remove { id }
message.new     { message }                    for the map's relay arc and the thread view
project.upsert / project.remove / team.upsert / team.remove
server.info     { version, uptime, runningUnits, maxUnits }
```

Client → server: `{ type: "ping" }` only; all commands go through REST. Reconnect with backoff on the client; the server tolerates many sockets.

## Persistence (SQLite)

Tables: `projects`, `teams`, `units` (incl. `session_id`, `status`, `status_since`), `orders`, `messages`, `message_deliveries`, `transcript` (unit_id, at, kind, json), `alerts`, `push_subscriptions`, `settings` (key/value). Migrations run at boot, forward only. `transcript` is pruned to the newest 5 000 rows per unit nightly.

On boot: load fleet.json, upsert projects/teams/units (fleet.json wins for structure, DB wins for `session_id`/`status_since`), start `autostart` units with `resume` when a session id exists; any unit that was `working` at shutdown becomes `offline` with an `info` alert ("was mid-turn when the server stopped").

## Testing

- `statusMachine` and `activity` are pure and fully unit-tested (vitest).
- `UnitRuntime` is tested against a **fake SDK**: `packages/server/test/fakeSdk.ts` implements the `query()` surface (async generator + `interrupt` + `canUseTool` invocation) with scripted scenarios: happy turn, permission wait, AskUserQuestion, interrupted turn, crash. CI must not need an Anthropic login.
- One opt-in integration test (`FLEET_E2E=1`) runs a real `haiku` unit with a trivial prompt.
