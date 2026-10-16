# Grid Commander

Browser UI for running many Claude Code sessions in parallel across several projects, presented as a Civilization-style hex map. Each session is a military unit on a hex inside a project's territory. The operator commands the fleet from a desktop browser or an Android phone.

Spec: `docs/` (start with `docs/00-overview.md`; build plan in `docs/06-milestones.md`; deviations in `docs/decisions.md`).

## Requirements

- Node 20+ and pnpm 10 (`npm i -g pnpm@10`).
- A Claude login on the machine (`claude` CLI logged in) or `ANTHROPIC_API_KEY`.

## Run

```bash
pnpm install
pnpm dev                                # server on :7777 (tsx watch) + Vite on :5173
```

`pnpm dev` is the hot-reloading way to run Grid Commander while it is being changed:

| You edit | What happens |
|---|---|
| `packages/client/src/**` | Vite hot-module reload: styles and components update in the open browser, no refresh |
| `packages/server/src/**` | `tsx watch` restarts the web server in about a second; the browser reconnects on its own |
| `packages/shared/src/**` | `tsc -w` re-emits; server and client pick it up as above |

Unit sessions do not live in the web server. They run in the **unit host**, a detached process the server launches on first use (`data/host.pid`, log in `data/host.log`, Unix socket `data/host.sock`) and attaches to over a socket. Restarting the web server, by hot reload, `Ctrl-C` + `pnpm start`, or a crash, leaves every Claude session running; the new server re-attaches and replays whatever happened while it was down, so transcripts and results are not lost. Orders are tracked to completion: if a session ever does die mid-order (host restart, machine reboot), the order goes back to the front of the unit's queue and is resubmitted, with a note, once the session resumes.

Vite listens on all interfaces (`--host`), so the phone can use `http://<mac-ip>:5173` too; the API and WebSocket are proxied to the server, which stays on 127.0.0.1.

Open http://localhost:5173 and paste the token when prompted. The token is read from `FLEET_TOKEN`, or, when that is unset, generated once and kept in `data/token`:

```bash
open "http://localhost:5173/?token=$(cat data/token)"
```

`fleet.json` is optional. With no file (or an empty one) the map starts as open water: found projects, reshape their territories and recruit units from the UI, and the server writes the result back to `fleet.json`. `fleet.example.json` shows the hand-written form if you prefer to start from a file (edit its `cwd` paths to real repos first).

Production-style:

```bash
pnpm build
FLEET_TOKEN=... FLEET_HOST=0.0.0.0 pnpm start   # serves client from packages/client/dist on :7777
pnpm stop --keep-units                          # stop the web server only; sessions keep running in the host
pnpm host:restart                               # stop the host (sessions end); the running server relaunches it and resumes every unit
pnpm stop                                       # stop both: web server and unit host
```

The host runs the code it was started with. After changing anything under `packages/server/src/runtime/` or `src/host/`, run `pnpm host:restart` when the fleet is at a stopping point: units are resumed by session id and interrupted orders are resubmitted, but the turn that was running is redone. Everything else (REST, WebSocket, comms, alerts, the UI) is picked up by a plain server restart with no effect on units. Set `FLEET_INPROC=1` to run sessions inside the web server instead (the pre-host behaviour; the Playwright suite uses it).

## Demo mode (no Claude needed)

```bash
pnpm start:demo        # FLEET_DEMO=1 with token demo-token-12345678 unless FLEET_TOKEN is set
pnpm stop
```

Units run a scripted runtime: orders containing "permission", "question", "fail" or "long" exercise those paths. Useful for trying the UI and for the Playwright suite.

## Phone, PWA and push

The app installs as a PWA and runs on Android Chrome. Installability and Web Push need HTTPS:

- **Tailscale (recommended):** on the server machine run `tailscale serve --bg 7777`, then open `https://<machine>.<tailnet>.ts.net/` on the phone. Tailscale provides the certificate.
- **LAN with mkcert:** `mkcert -install && mkcert <lan-ip>`, then put a TLS proxy (Caddy: `caddy reverse-proxy --from <lan-ip>:8443 --to 127.0.0.1:7777`) in front and trust the mkcert root on the phone.

Push notifications:

```bash
npx web-push generate-vapid-keys        # once
export VAPID_PUBLIC_KEY=... VAPID_PRIVATE_KEY=... VAPID_SUBJECT=mailto:you@example.com
```

Then open Commands → Settings on the phone and tap "Enable push on this device". Pushes go out for `waiting`, `error` and `done` by default (configurable in Settings), coalesced to one per unit per minute, and deep-link to the unit. Push only arrives while Chrome is alive on Android; it is not a system service. If the server is unreachable the installed app opens with the last snapshot and a red "offline · cached" pill; commands are disabled until the socket is back.

## Environment

| Var | Default | Purpose |
|---|---|---|
| `FLEET_TOKEN` | generated | bearer token for REST and WS (`?token=` on WS upgrade); when unset, read from or written to `<data dir>/token` |
| `FLEET_HOST` | `127.0.0.1` | bind address; `0.0.0.0` for LAN/Tailscale |
| `FLEET_PORT` | `7777` | |
| `FLEET_CONFIG` | `./fleet.json` | fleet definition; written back when you edit from the UI |
| `FLEET_DB` | `./data/fleet.db` | SQLite file; its directory is the data dir (token, host pid/log/socket) |
| `FLEET_INPROC` | unset | `1` runs sessions inside the web server instead of the unit host (they stop when it stops) |
| `FLEET_HOST_SOCKET` | `<data dir>/host.sock` | unit host socket; falls back to the temp dir when the path exceeds the OS limit (~100 bytes) |
| `FLEET_HOST_IDLE_EXIT_MS` | `600000` | the host exits after this long with no server attached and no units running; `0` never |
| `FLEET_IDLE_ALERT_MS` | `120000` | idle watchdog threshold |
| `FLEET_DONE_AUTOACK_MS` | `600000` | auto-acknowledge `done` after this long |
| `FLEET_MAX_UNITS` | `24` | cap on concurrently running sessions |
| `FLEET_BROWSE_ROOTS` | home dir + fleet root | comma-separated directories the project "Browse…" picker may list (directories only; `..` cannot escape, symlinked folders inside a root are followed) |
| `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` | optional | Web Push |
| `ANTHROPIC_API_KEY` | optional | passed through to the SDK |

## Client

Desktop: left-drag pans, right/middle or shift-drag rotates, wheel zooms, arrow keys pan, `[`/`]` rotate, `-`/`=` zoom. Click a unit or tray card to select it (shift-click for multi-select); click a territory to select its project; `L` toggles the legend; `Esc` clears.
Mobile: one finger pans, pinch zooms, two-finger drag rotates.

Paste the token once at the gate, or open `http://host:7777/?token=<FLEET_TOKEN>`; it is kept in that browser's localStorage.

## Scripts

- `pnpm dev` / `pnpm build` / `pnpm test` / `pnpm lint`
- `pnpm --filter @gridcommander/client test:e2e` runs the Playwright suite (desktop smoke, full command flow on the demo runtime, mobile layout). Needs `pnpm build` first and `pnpm --filter @gridcommander/client exec playwright install chromium-headless-shell` once.
- `pnpm cli unit run --project <id> --type infantry "<prompt>"` runs one unit in the terminal (M1).
- `FLEET_E2E=1 pnpm test` additionally runs the real-SDK integration tests (needs a Claude login).

## Layout

```
packages/shared   types + zod schemas + unit-types.json (everything that crosses the wire)
packages/server   Fastify + WebSocket + SQLite (src/) and the unit host that owns the Agent SDK sessions (src/host/)
packages/client   Vite + React + react-three-fiber + PWA
docs/             spec and decisions
```
