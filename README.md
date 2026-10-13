# Grid Commander

Browser UI for running many Claude Code sessions in parallel across several projects, presented as a Civilization-style hex map. Each session is a military unit on a hex inside a project's territory. The operator commands the fleet from a desktop browser or an Android phone.

Spec: `docs/` (start with `docs/00-overview.md`; build plan in `docs/06-milestones.md`; deviations in `docs/decisions.md`).

## Requirements

- Node 20+ and pnpm 10 (`npm i -g pnpm@10`).
- A Claude login on the machine (`claude` CLI logged in) or `ANTHROPIC_API_KEY`.

## Run

```bash
pnpm install
cp fleet.example.json fleet.json        # edit project cwd paths to real repos
export FLEET_TOKEN=$(openssl rand -hex 24)
pnpm dev                                # server on :7777 (tsx watch) + Vite on :5173
```

Open http://localhost:5173 and paste the token when prompted.

Production-style single process:

```bash
pnpm build
FLEET_TOKEN=... FLEET_HOST=0.0.0.0 pnpm start   # serves client from packages/client/dist on :7777
```

## Demo mode (no Claude needed)

```bash
FLEET_DEMO=1 FLEET_TOKEN=demo-token-12345678 pnpm start
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
| `FLEET_TOKEN` | required | bearer token for REST and WS (`?token=` on WS upgrade) |
| `FLEET_HOST` | `127.0.0.1` | bind address; `0.0.0.0` for LAN/Tailscale |
| `FLEET_PORT` | `7777` | |
| `FLEET_CONFIG` | `./fleet.json` | fleet definition; written back when you edit from the UI |
| `FLEET_DB` | `./data/fleet.db` | SQLite file |
| `FLEET_IDLE_ALERT_MS` | `120000` | idle watchdog threshold |
| `FLEET_DONE_AUTOACK_MS` | `600000` | auto-acknowledge `done` after this long |
| `FLEET_MAX_UNITS` | `24` | cap on concurrently running sessions |
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
packages/server   Fastify + WebSocket + Agent SDK runtime + SQLite
packages/client   Vite + React + react-three-fiber + PWA
docs/             spec and decisions
```
