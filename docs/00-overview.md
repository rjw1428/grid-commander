# Grid Commander — Overview

Grid Commander is a browser UI for running many Claude Code sessions in parallel across several projects, presented as a Civilization-style hex map. Each session is a military **unit** standing on a hex inside a project's **territory**. Units have a rank that encodes their role and model, an animated work loop, and the ability to message other units. The operator (Ryan) commands the fleet from a desktop browser or an Android phone.

This folder is the build specification. It is written for a Claude Code agent to implement, milestone by milestone (see `06-milestones.md`). `prototype/index.html` is a working single-file prototype of the map, unit rigs, animations, command bar and notifications running on simulated data; port its visual behaviour rather than re-inventing it.

## Decisions already made

| Topic | Decision |
|---|---|
| Platforms | Web app, installable as a PWA on Android. One codebase. No native Android client. |
| Session ownership | The server spawns and owns every Claude Code session through the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`). tmux is not the runtime. |
| Agent-to-agent messaging | Inbox delivered at turn boundaries by default; a sender may flag a message **urgent**, which interrupts the recipient and delivers immediately. |
| Stack | TypeScript end to end. Node 20+ server (Fastify + WebSocket), React + react-three-fiber client (Vite), SQLite for persistence. pnpm monorepo. |
| Auth | Single shared bearer token (`FLEET_TOKEN`). The server is meant to run on the operator's machine and be reached over LAN or Tailscale. |
| Theme | Military. Units are low-poly video-game soldiers. Rank = role × model. Project = armband + base-plate colour. |

## Glossary

- **Unit**: one Claude Code session. Has a type (rank), a project, a hex, a status, a transcript, an inbox and an order queue.
- **Unit type / rank**: Engineer (opus, architect), Infantry (sonnet, builder), Sniper (haiku, scout), Captain (sonnet, reviewer), Major (opus, merge broker), General (opus, orchestrator). Types are data (`unit-types.json`), not code; adding one must not require touching the renderer beyond providing a rig.
- **Project / territory**: a repository (or worktree root) and the set of hexes it owns on the map.
- **Team**: an operator-defined group of units, possibly across projects, used for broadcast and for comms scope.
- **Order**: a prompt the operator sends to a unit. Becomes a user turn.
- **Turn**: one prompt → one `result` from the SDK.
- **Message**: a unit-to-unit (or operator-to-unit) communication with priority `normal` or `urgent`.
- **Alert**: an operator-facing notification (unit waiting, errored, finished, idle too long, message received).

## Non-goals (v1)

- Multi-operator / accounts. One token, one operator.
- Hosting the server anywhere but the operator's own machine.
- Replacing the terminal. A unit's session can be taken over in a terminal with `claude --resume <session_id>` after the unit is stopped in the UI.
- iOS. (The PWA will mostly work in Safari but is not a target.)
- Attach to pre-existing tmux sessions. May be added later as a second runtime adapter; keep the runtime behind an interface (`03-server.md`).

## Reading order for the implementing agent

1. `01-architecture.md` — repo layout, processes, data flow.
2. `02-domain-model.md` — entities, status machine, unit types.
3. `03-server.md` — runtime, API, persistence.
4. `04-agent-comms.md` — messaging, MCP tools, hooks.
5. `05-client.md` — map, rigs, animations, desktop and mobile UI, PWA.
6. `06-milestones.md` — build order and acceptance criteria. Start here when coding.
7. `07-kickoff-prompt.md` — the prompt to give the Claude Code agent.
