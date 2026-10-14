# Decisions and spec deviations

Recorded as the build progresses. Newest at the bottom.

## M0

- **Prototype not supplied.** `prototype/index.html` is referenced throughout the spec as the visual reference but was not in the repository. Rigs, animations, camera and map look are implemented from the descriptions in `docs/05-client.md` (rig table, status poses, identity colours, rings, beacons). If the prototype turns up later, drop it in `prototype/` and diff the rigs against it.
- **React 19 instead of React 18.** `@react-three/fiber@9` and `@react-three/drei@10` peer-depend on React 19; staying on 18 would pin fiber 8 / drei 9. Nothing in the spec depends on an 18-only API.
- **Zod 4.** `@anthropic-ai/claude-agent-sdk` peer-depends on `zod@^4`, and the SDK's `tool()` takes a zod v4 raw shape. One zod version across the workspace avoids dual-package type clashes.
- **`unit-types.json` lives at `packages/shared/src/unit-types.json`** (spec says `packages/shared/unit-types.json`) so `tsc` copies it into `dist/` on build and the JSON import works identically in Node and Vite.
- **Agent SDK pinned to 0.3.296**, API names verified against the installed `sdk.d.ts`: `query({ prompt: AsyncIterable<SDKUserMessage>, options })` → `Query` with `interrupt()`, `setModel()`, `setPermissionMode()`, `close()`, `getContextUsage()`, `mcpServerStatus()`; `canUseTool(toolName, input, { signal, suggestions })` → `{ behavior: "allow" | "deny", ... }`; `createSdkMcpServer({ name, tools })` + `tool(name, description, zodShape, handler)`; hooks as `Partial<Record<HookEvent, HookCallbackMatcher[]>>` with `PostToolUse` → `hookSpecificOutput.additionalContext` and `Stop` → `last_assistant_message`. Result subtypes: `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.
- **PermissionMode** mirrors the SDK's current union: `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`.
- **Repo name.** The GitHub repo is `grid-commander`; the product and package scope stay `Grid Commander` / `@gridcommander/*` as the spec names them.

## M1

- **`start()` does not wait for `system/init`.** Verified against the real SDK (0.3.296): in streaming-input mode the CLI emits `system/init` only after the first user message arrives, so a runtime that waited for init before accepting orders would hang. `start()` resolves once the SDK process is spawned and has not exited within a short grace window (`startGraceMs`, default 1.5 s); status becomes `idle` at that point. `InitInfo` (session id, model, tools, MCP server statuses) is captured on the `init` runtime event when it arrives with the first turn. The status machine is unchanged: `offline → idle` is still driven by the `init` event; the runtime simply fires it on spawn.
- **`rate_limit_event` is informational.** The SDK emits one on every turn with `rate_limit_info.status`; only a non-`allowed` status produces an operator notice.
- **Type-only SDK imports** live in `src/runtime/sdkTypes.ts` so the fake SDK and tests share shapes; types are erased so the single-runtime-import rule in CLAUDE.md still holds for runtime code.
- **AskUserQuestion is answered through `canUseTool`:** the runtime returns `{ behavior: "allow", updatedInput: { ...input, answers } }`, which is how the SDK expects hosts to answer. The spec's "assistant calls AskUserQuestion → waiting" is satisfied because the permission callback fires at that moment.
- **Interrupt during a permission wait** uses the SDK's `{ behavior: "deny", interrupt: true }` escape hatch and then `interrupt()`; the turn resolves as interrupted.

## M2

- **Boot merge rule.** For entities present in both `fleet.json` and the DB, `fleet.json` wins for structure (name, type, project, hex, task, model, permission mode, team) and the DB wins for `sessionId`, `statusSince`, `lastResult`, `missionDone`, `createdAt`. Entities only in the DB are kept (deleting from `fleet.json` by hand does not delete data; delete from the UI or API instead). All units boot `offline`; units that were `working`/`waiting` at shutdown get an `info` alert.
- **Orders to an offline unit auto-start it.** The spec is silent; an operator sending an order plainly wants the unit to run. The order is queued, `start()` is kicked off, and the queue drains when the runtime reports idle. Disable with `autoStartOnOrder: false` on the hub.
- **"Interrupt & send" is implemented as front-of-queue + interrupt.** The order is inserted at the head of the FIFO and `interrupt()` is called; the interrupted `result` triggers the normal drain, so the urgent order is the next turn, ahead of anything already queued.
- **Transcript tool results update in place.** `unit.transcriptUpdate { unitId, toolUseId, ok, durationMs }` was added to the WS union (the spec only listed appends) so the client can flip a tool line to ok/failed without a duplicate entry.
- **Alerts for `done`/`error` derive from `turnFinished`**, not the status transition, so the alert body carries the result text. Interrupted turns raise no `done` alert.
- **Error handler ordering.** Fastify child plugins inherit the error handler that exists at registration time, so `setErrorHandler` runs before `/api` is registered; otherwise `ApiError`s fall back to Fastify's default envelope.
- **PermissionBridge is folded into UnitService** (`answerPermission`/`answerQuestion` delegate to the runtime). A separate class added nothing while there is one runtime per unit.
- **Settings live in the `settings` table** and are exposed in the snapshot (`comms.crossProject`, `push.kinds`, `alerts.idleMs`, `alerts.doneAutoAckMs`); `FLEET_IDLE_ALERT_MS` seeds the idle threshold until the operator changes it.

## M3

- **No prototype to port**, so the rigs are original: boxes and cylinders with `flatShading`, parts grouped as `legs/torso/armL/armR/head/props`, posed per frame by a pure `poseSoldier()` in `src/map/rigs/pose.ts` (unit-tested). Headgear, props and work loops follow the table in `docs/05-client.md`. Soldiers face +z (toward the default camera).
- **Labels are DOM nodes projected per frame** through a module-level registry (`labelNodes.ts`): React owns the label content, a `useFrame` projector writes `transform`/`opacity` directly, so nothing re-renders at 60 fps. Project nameplates sit one row behind the territory's back row so they do not collide with unit labels.
- **Camera is a custom orbit rig**, not drei's OrbitControls: Civ-style left-drag pan, right/middle/shift-drag rotate, wheel zoom, one-finger pan, pinch zoom, two-finger rotate, arrow keys. Distance 8–40, pitch 0.35–1.45. A drag swallows the trailing click so selection is not cleared.
- **Zustand 5 selectors that build arrays/objects are wrapped in `useShallow`**; a fresh reference per call makes React 19 loop (error #185). The store itself keeps maps keyed by id so plain field selectors are stable.
- **Static client serving uses wildcard routing** (`@fastify/static` default) with an SPA fallback for extension-less GETs, so a rebuilt client with new asset hashes is served without restarting the server.
- **Token entry**: `?token=` on the URL is moved into localStorage and stripped from the address bar; otherwise a gate form asks for it. A 401 on reconnect clears it and re-shows the gate.
- **Playwright smoke test runs against the real server** (`packages/server/dist`) with `fleet.example.json` and an in-memory DB: all units stay offline, so no Claude login is needed. Headless Chromium renders the scene through SwiftShader; `pnpm --filter @gridcommander/client test:e2e`.

## M4

- **`FLEET_DEMO=1` runs a scripted `DemoRuntime`** (`src/runtime/DemoRuntime.ts`) behind the same `Runtime` interface: order text containing "permission", "question", "fail" or "long" steers the script. It exists so the UI can be driven end to end (Playwright `command.spec.ts`) and demoed without a Claude login or token spend. The server logs a warning at boot when it is on.
- **Opening a `done` unit acknowledges it** (spec: "operator acknowledges (opens the unit or clicks Ack)"). The Ack button remains for `error`.
- **Transcript is windowed, not virtualised.** The store keeps a 500-entry ring; the panel renders the newest 120 and "Load earlier" widens the window before fetching older rows with `?before=`. With the ring capped at 500 this keeps the DOM small without a variable-height virtual list.
- **Halt all / Compact idle are client-side fan-outs** over the per-unit endpoints; no new server routes were needed.
- **Next orders** cycles through units in `waiting → error → done` order (oldest first within a rank) and wraps; `N` and Space trigger it. Esc interrupts the selected working unit, cancels move mode, or clears the selection, in that order.
- **Move mode** is store state (`mode: "move"`, `moveUnitId`): a tile click PATCHes `hex` (and `projectId` when the tile belongs to another territory); occupancy is checked client-side first and again by the server (409).
- **Sounds** use WebAudio triangle beeps (660 Hz waiting, 220 Hz error, 880 Hz done, 740 Hz message) and are gated behind the Sound toggle because an AudioContext needs a gesture.
- **Playwright runs the server on a temp copy of `fleet.example.json`** because the server writes back to `FLEET_CONFIG`; an earlier run had appended a recruited unit to the committed example.

## M5

- **Fleet MCP tools are pre-allowed** via the SDK's `allowedTools` (`mcp__fleet__*`). Without this a unit in `default` permission mode blocks on an operator prompt the first time it calls `fleet_send`, which is exactly the hang the first real-SDK comms run hit. The operator still governs Bash/Edit/etc. through `canUseTool`.
- **Urgent delivery preempts the order queue** through an `OrderService.setPreempt` hook: while a unit has an urgent message pending, the drain hands the turn boundary to the broker, which submits the inbox first; queued orders follow.
- **Urgent while waiting on a permission**: the broker marks the unit urgent-pending; when the operator's answer flips `waiting → working`, the broker interrupts and the inbox turn is delivered next.
- **`fleet_send` to a group** (team/project) silently drops recipients the policy denies and only errors when nobody remains; a direct unit send errors with the explanatory message and the `"general"` hint.
- **Message arcs**: `message.new` events younger than 5 s draw a bezier arc from sender hex to each recipient (gold normal, red-orange urgent, grey operator). Operator messages start at the HQ territory, or off-map when no `hq` project exists.
- **`Messages` command** opens a fleet-wide feed; the per-unit Messages tab shows threads with reply-in-thread, compose with priority, and Relay output.
- **Implicit threading.** When a unit messages the unit that most recently wrote to it (within an hour) and omits `replyTo`, the broker threads it as a reply. Observed with haiku units: they answer promptly but forget `replyTo`. `replyTo` also accepts a thread id.
- **Chatter risk.** Two or three units can keep acknowledging each other indefinitely because every inbox delivery is a fresh turn. The inbox footer now says to reply only when the sender needs something and never to send acknowledgements. If this is not enough in practice, the next lever is a per-thread cap on consecutive unit-to-unit turns, surfaced to the operator as an alert.

## M6

- **Icons are generated at build by a dependency-free PNG encoder** (`packages/client/scripts/icons.mjs`, zlib + CRC): 192, 512 and a maskable 512, plus an SVG. No sharp/canvas native dependency.
- **Service worker uses `injectManifest`** (`src/sw.ts`) rather than `generateSW`, because the push and notification-click handlers have to live in the worker. Workbox precaches the shell; navigations fall back to `index.html`; `/api` and `/ws` are never cached.
- **Offline shell**: the latest snapshot is written to IndexedDB (idb-keyval, throttled to one write per 2 s). If no live snapshot arrives within 2.5 s of load, the cached one is applied with `connection: "offline"` and a `cachedAt`; the app adds a `readonly` class that disables every command control.
- **Push coalescing** is per unit (or per kind for unit-less alerts) with a 60 s window; refreshed tiles (idle minutes ticking) do not re-push, except `waiting`, which is always news. 404/410 from the push service prune the subscription.
- **Mobile camera nudge**: the sheet height (52 % / 78 %) is passed as `focusOffsetY` and the camera target is pushed toward the camera so the focused unit sits above the sheet.
- **Push on a physical phone was not verified in this environment** (no Android device attached). The plumbing is covered by `push.test.ts` (sender, coalescing, pruning) and the SW handlers are exercised by Chromium only for registration; test the first push with `tailscale serve` as the README describes.

## M7

- **Context watchdog** polls `getContextUsage()` for running units every 5 min (`contextCheckMs`) and raises one `info` alert per unit at ≥70 %, re-armed when usage drops under 50 %.
- **Transcript export** is `GET /api/units/:id/transcript.md` (newest 5 000 rows rendered as Markdown) with a button in the unit's Settings tab; the client fetches with the bearer token and triggers a download.
- **Nightly pruning** keeps the newest 5 000 transcript rows per unit (24 h interval from boot, not at a fixed hour).
- **`TmuxRuntime` was not built.** The `Runtime` interface and `RuntimeFactory` are the seam for it; `DemoRuntime` is a second implementation that proves the seam holds.

## Naming

- The product is called **Grid Commander** everywhere (operator request, 2026-10-13). The spec documents originally said "Hex Command"; they, the package scope (`@gridcommander/*`), PWA manifest, storage keys and system prompt were all renamed in one pass.
- **Relative `FLEET_CONFIG` / `FLEET_DB` / `FLEET_ROOT` resolve against `INIT_CWD`** (the directory `pnpm start` was invoked from), not `packages/server`, and a missing fleet file logs a warning instead of silently starting empty.

## Building the fleet from the UI (2026-10-14)

- **`fleet.json` is optional.** A missing or empty file is an empty fleet; everything can be founded from the UI and is written back. Playwright passes absolute paths because relative `FLEET_*` paths resolve against `INIT_CWD`.
- **Projects are founded from the UI** (`+ Project` in the header, `P`, the command bar, the mobile command sheet, or the open-water empty state) with a name, working directory and a territory size of 7, 19 or 37 hexes. The server places the cluster in free water with a one-hex gap (`CreateProjectBody.size`); colours come from the palette.
- **Territory mode** (project panel → Edit territory) shows translucent candidate hexes: free neighbours of the territory that are not adjacent to another project, so the water gap is preserved. Clicking a candidate claims it, clicking an owned hex releases it; a hex with a unit on it and the last hex cannot be released. Each click is one `PATCH /projects/:id {cells}`, validated server-side.
- **Project details** (name, cwd, tint, flag) are edited in the panel; deletion is a two-step inline confirm and refused while units remain.
- **Token file.** With `FLEET_TOKEN` unset the server generates a 48-hex token into `<data dir>/token` (mode 0600) and logs the file path, never the token.
