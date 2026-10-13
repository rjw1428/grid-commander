# 06 — Milestones

Build in this order. Each milestone ends with a commit on `main`, green `pnpm test`, and the acceptance checks below passing. Do not start the next milestone with failing checks. Keep `README.md` current with how to run.

## M0 — Scaffold (½ day)

- pnpm workspace, three packages, strict TS, eslint/prettier, vitest, root `pnpm dev` (server with tsx watch + Vite dev proxying `/api` and `/ws`), `pnpm build`, `pnpm test`.
- `shared`: domain types + zod schemas from `02-domain-model.md`; `unit-types.json` with the six types; WS event union.
- `fleet.example.json`; `CLAUDE.md` (from `07-kickoff-prompt.md`).

Accept: `pnpm build` succeeds; `pnpm test` runs ≥ 1 schema test; `GET /health` answers.

## M1 — Runtime core (1–2 days)

- `UnitRuntime` with the Agent SDK in streaming-input mode; `statusMachine`, `activity`; fake SDK test harness.
- `pnpm cli unit run --project <id> --type infantry "<prompt>"` dev command that spawns one unit, prints status transitions and transcript lines, exits on `result`.

Accept: fake-SDK scenarios (happy turn, permission wait → allow, AskUserQuestion → answer, interrupt, crash) each drive the expected status sequence; with `FLEET_E2E=1` a real haiku unit completes "Reply with the word ready" and status goes `offline → idle → working → done`.

## M2 — Store, services, API, WS (1–2 days)

- SQLite migrations; FleetService (fleet.json load + write-back); OrderService queue; PermissionBridge; REST routes; WS snapshot + deltas; bearer auth.
- Boot resumes `autostart` units by `sessionId`.

Accept: REST contract tests via Fastify inject for every route; WS test receives `snapshot` then a `unit.upsert` after an order; restart the server and a unit with a stored session resumes (`FLEET_E2E=1`); 401 without token.

## M3 — Map and rigs (2 days)

- Client scaffold, store, WS client with reconnect, REST client.
- Hex map, territories, borders, camera controls (mouse + touch), labels.
- Six soldier rigs with props and all work/status animations ported from the prototype; identity colours; rings; beacons.
- Desktop header, tray, legend. Read-only against live server state.

Accept: with `fleet.example.json` and units left `offline`, the map renders every unit on its hex with correct rig, armband and plate colours; starting a unit via REST animates it on the map within 200 ms of the WS event; Playwright smoke test passes; 60 fps on desktop with 24 offline units.

## M4 — Command and control (2 days)

- Unit panel: transcript, orders (send / interrupt & send / queue), permission approve/deny with "always allow", AskUserQuestion answers, interrupt, compact, ack, start/stop, model and permission-mode live changes.
- Group panel, broadcast with queue-if-busy, teams create/disband, move/reassign (hex click, occupancy check, project change), recruit dialog, halt all, compact idle.
- Alert engine + alert stack + Next orders cycling + idle watchdog + sounds.

Accept: operator can run a two-unit session entirely from the UI: recruit an Infantry with a first order, watch it work, approve a permission, see `done`, send a queued second order that auto-submits, group both units into a team and broadcast. Every alert kind can be produced and dismissed.

## M5 — Agent comms (2 days)

- `fleet` MCP server per unit with the five tools; scope policy; CommsBroker delivery (turn-boundary, hook nudge, urgent interrupt, offline hold); message turn format; Stop hook capture; threads.
- Client: Messages tab, compose with priority, relay output, arcs on the map, `message` alerts for General/urgent.

Accept: fake-SDK tests for policy and each delivery path; with `FLEET_E2E=1`: an Engineer told "ask xre-cache via fleet_send what branch it is on" produces a message, the Infantry (idle) receives it as a turn and replies in-thread; an urgent message to a working unit interrupts and is delivered; a cross-project send from an Infantry is denied with the explanatory error, while a send to `"general"` succeeds.

## M6 — Mobile and PWA (1–2 days)

- Mobile layout: bottom tab bar, sheet, banner, multi toggle, camera nudge; touch gestures verified on Android Chrome.
- PWA manifest, service worker, offline shell with last snapshot, install prompt.
- Web Push: VAPID keys, subscribe/unsubscribe, server sends on waiting/error/done (coalesced), deep links.

Accept: Lighthouse PWA installable; installed app on an Android phone over Tailscale receives a push when a unit waits for permission, opening it selects that unit; every M4 action is doable on a phone.

## M7 — Robustness and polish (ongoing)

- Max-units cap and clear errors; API retry/rate-limit surfacing; transcript pruning; nightly compaction suggestion for long sessions (alert when `getContextUsage()` exceeds 70 %).
- "Open in terminal" instructions per unit (`claude --resume <id>` after Stop).
- Settings page: comms policy toggle, push kinds, idle threshold, sound.
- Export: a unit's transcript as Markdown.
- Optional: `TmuxRuntime` adapter for attaching to hand-started sessions (status via hooks only; read-only transcript).

## Definition of done per feature

Typed end to end (shared schema) · persisted where state outlives a request · pushed over WS · reachable on desktop and mobile · covered by at least one test · documented in README if it needs operator setup.
