# 07 — Kickoff

## Repo setup

```bash
mkdir gridcommander && cd gridcommander && git init
mkdir -p docs prototype
cp /path/to/spec/*.md docs/
cp /path/to/prototype/index.html prototype/index.html
claude
```

## CLAUDE.md (place at repo root before starting)

```markdown
# Grid Commander

Browser UI for orchestrating many Claude Code sessions as military units on a hex map. Spec lives in docs/ (read docs/00-overview.md first; docs/06-milestones.md is the plan). prototype/index.html is the visual reference for the map, soldier rigs and animations; port, don't reinvent.

## Stack
pnpm monorepo. packages/shared (types + zod), packages/server (Fastify, ws, @anthropic-ai/claude-agent-sdk, better-sqlite3), packages/client (Vite, React 18, react-three-fiber, drei, zustand, vite-plugin-pwa). TypeScript strict everywhere. vitest. Node 20+.

## Rules
- Anything crossing the wire is typed in packages/shared and validated with zod on receipt.
- The Agent SDK is imported only in packages/server/src/runtime/UnitRuntime.ts. All tests use the fake SDK in packages/server/test/fakeSdk.ts unless FLEET_E2E=1.
- No shell execution of operator input. No secrets in logs. Bearer token on every route and the WS upgrade.
- Mobile is a first-class layout, not a media-query afterthought: every operator action must work on a phone.
- Commit at the end of each milestone with green `pnpm test` and `pnpm build`. Conventional commit messages.
- When the spec is silent, choose the simplest option that keeps the Runtime interface abstract, and note the choice in docs/decisions.md.
- Verify Agent SDK API names against https://code.claude.com/docs/en/agent-sdk/typescript before using them; the spec quotes them but versions move.
```

## First prompt to the agent

```
Read docs/00-overview.md through docs/06-milestones.md and prototype/index.html. Then implement milestone M0 from docs/06-milestones.md. Before writing code, list any ambiguities you found in the spec with the default you intend to take; then proceed without waiting. When M0's acceptance checks pass, commit and summarise in five lines, then continue to M1.
```

## Per-milestone prompt

```
Continue with milestone M<n> from docs/06-milestones.md. Re-read the relevant spec sections first (docs/0<x>-*.md). Run the acceptance checks for M<n> before committing. Record any spec deviations in docs/decisions.md.
```

## What to watch for while it builds

- M1: the fake SDK must mirror the real `query()` shape closely (async generator + `interrupt()` + `canUseTool` invocation + `hooks` callbacks) or M5 will be wrong. Ask the agent to show the harness before accepting M1.
- M3: the rigs are the identity of the product. Check the map yourself at M3 before M4; a weak port here propagates.
- M5: run the real-SDK E2E once with two haiku units. Watch for the inbox turn being delivered while an order is queued (orders win) and for a denied cross-project send producing the explanatory error rather than silently failing.
- M6: test push on the phone, not in desktop Chrome's device mode.
