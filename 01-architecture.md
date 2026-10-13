# 01 — Architecture

## Repository layout (pnpm workspace)

```
hexcommand/
  package.json            # workspaces, root scripts: dev, build, test, lint
  pnpm-workspace.yaml
  tsconfig.base.json
  CLAUDE.md               # repo conventions for the agent (see 07-kickoff-prompt.md)
  docs/                   # this spec
  packages/
    shared/               # types + zod schemas shared by server and client; NO runtime deps beyond zod
    server/               # Fastify + ws + Agent SDK runtime + SQLite
    client/               # Vite + React + react-three-fiber + PWA
  prototype/index.html    # reference implementation of map/rigs/animations (read-only)
  fleet.example.json      # example fleet config
```

- `shared` exports: domain types (`Unit`, `Project`, `Team`, `Message`, `Alert`, `Order`, `UnitStatus`, `UnitTypeDef`), the WebSocket event union, REST request/response schemas, and `unit-types.json` loaded as a typed constant.
- Server and client import only from `@hexcommand/shared` for anything crossing the wire. Zod schemas validate every inbound REST body and every WS message on the client.

## Processes

One Node process (`packages/server`) does everything:

1. **HTTP + static**: serves the built client (`packages/client/dist`) and the REST API under `/api/*`.
2. **WebSocket** at `/ws`: pushes a full `snapshot` on connect, then deltas. Multiple clients (desktop + phone) may be connected at once and see the same state.
3. **Runtime**: one `UnitRuntime` per running unit, wrapping an Agent SDK `query()` in streaming-input mode. Owns the SDK process lifecycle, translates `SDKMessage`s into domain events, services the order queue and inbox, and answers permission requests.
4. **Comms broker**: routes `Message`s between units, applies scope policy, chooses inbox vs interrupt delivery.
5. **Alert engine**: derives operator alerts from unit events and the idle watchdog; optionally sends Web Push.
6. **Store**: SQLite (`better-sqlite3`, WAL mode). Single file, `FLEET_DB` env, default `./data/fleet.db`.

Everything in-memory is reconstructible from SQLite plus the SDK's own session transcripts (`resume` by `session_id`).

## Data flow

```
operator (browser) ──REST /api/units/:id/orders──▶ server.OrderQueue ──▶ UnitRuntime.submit() ──▶ Agent SDK ──▶ claude process
                    ◀──WS unit.status / unit.transcript / alert ◀── UnitRuntime (from SDKMessage stream, canUseTool, hooks)

unit A ──MCP fleet_send──▶ CommsBroker ──inbox (normal) ──▶ UnitRuntime B delivers at next turn boundary
                                        └─interrupt (urgent) ─▶ UnitRuntime B: query.interrupt() → submit message turn
```

## Configuration

`fleet.json` (path from `FLEET_CONFIG`, default `./fleet.json`) is the operator's declarative starting point and is kept in sync by the server when projects/units are created from the UI (write-back, pretty-printed, atomic rename). Shape in `02-domain-model.md`.

Environment:

| Var | Default | Purpose |
|---|---|---|
| `FLEET_TOKEN` | required | bearer token for REST and WS (`?token=` on WS upgrade) |
| `FLEET_HOST` | `127.0.0.1` | bind address; set `0.0.0.0` for LAN/Tailscale |
| `FLEET_PORT` | `7777` | |
| `FLEET_CONFIG` | `./fleet.json` | |
| `FLEET_DB` | `./data/fleet.db` | |
| `FLEET_IDLE_ALERT_MS` | `120000` | idle watchdog threshold |
| `FLEET_MAX_UNITS` | `24` | hard cap on concurrently running SDK sessions |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Web Push |
| `ANTHROPIC_API_KEY` | optional | passed through to the SDK; otherwise the SDK uses the machine's Claude login |

## Key libraries (pin exact versions in package.json)

- Server: `fastify`, `@fastify/websocket`, `@fastify/static`, `@anthropic-ai/claude-agent-sdk`, `better-sqlite3`, `zod`, `web-push`, `pino`.
- Client: `react`, `react-dom`, `three`, `@react-three/fiber`, `@react-three/drei`, `zustand`, `vite`, `vite-plugin-pwa`, `zod`.
- Tooling: `typescript` (strict), `vitest`, `eslint` + `@typescript-eslint`, `prettier`, `tsx` for dev.

## Security posture

- Every REST route and the WS upgrade require `Authorization: Bearer <FLEET_TOKEN>` (WS: `?token=`). Constant-time compare.
- The server never executes operator-supplied shell. Orders are prompts; what the agent does with them is governed by the unit's `permissionMode` and the `canUseTool` callback (operator approves in the UI).
- CORS off (same origin only). The client is served by the same process.
- Log prompts and messages at `debug` only; transcripts contain code.
