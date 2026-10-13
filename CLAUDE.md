# Hex Command

Browser UI for orchestrating many Claude Code sessions as military units on a hex map. Spec lives in docs/ (read docs/00-overview.md first; docs/06-milestones.md is the plan). The prototype referenced by the spec (prototype/index.html) was not supplied; rigs and animations are built from the tables in docs/05-client.md.

## Stack
pnpm monorepo. packages/shared (types + zod), packages/server (Fastify, ws, @anthropic-ai/claude-agent-sdk, better-sqlite3), packages/client (Vite, React 19, react-three-fiber, drei, zustand, vite-plugin-pwa). TypeScript strict everywhere. vitest. Node 20+.

## Rules
- Anything crossing the wire is typed in packages/shared and validated with zod on receipt.
- The Agent SDK is imported only in packages/server/src/runtime/UnitRuntime.ts. All tests use the fake SDK in packages/server/test/fakeSdk.ts unless FLEET_E2E=1.
- No shell execution of operator input. No secrets in logs. Bearer token on every route and the WS upgrade.
- Mobile is a first-class layout, not a media-query afterthought: every operator action must work on a phone.
- Commit at the end of each milestone with green `pnpm test` and `pnpm build`. Conventional commit messages.
- When the spec is silent, choose the simplest option that keeps the Runtime interface abstract, and note the choice in docs/decisions.md.
- Verify Agent SDK API names against https://code.claude.com/docs/en/agent-sdk/typescript before using them; the spec quotes them but versions move.
