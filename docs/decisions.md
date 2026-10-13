# Decisions and spec deviations

Recorded as the build progresses. Newest at the bottom.

## M0

- **Prototype not supplied.** `prototype/index.html` is referenced throughout the spec as the visual reference but was not in the repository. Rigs, animations, camera and map look are implemented from the descriptions in `docs/05-client.md` (rig table, status poses, identity colours, rings, beacons). If the prototype turns up later, drop it in `prototype/` and diff the rigs against it.
- **React 19 instead of React 18.** `@react-three/fiber@9` and `@react-three/drei@10` peer-depend on React 19; staying on 18 would pin fiber 8 / drei 9. Nothing in the spec depends on an 18-only API.
- **Zod 4.** `@anthropic-ai/claude-agent-sdk` peer-depends on `zod@^4`, and the SDK's `tool()` takes a zod v4 raw shape. One zod version across the workspace avoids dual-package type clashes.
- **`unit-types.json` lives at `packages/shared/src/unit-types.json`** (spec says `packages/shared/unit-types.json`) so `tsc` copies it into `dist/` on build and the JSON import works identically in Node and Vite.
- **Agent SDK pinned to 0.3.296**, API names verified against the installed `sdk.d.ts`: `query({ prompt: AsyncIterable<SDKUserMessage>, options })` → `Query` with `interrupt()`, `setModel()`, `setPermissionMode()`, `close()`, `getContextUsage()`, `mcpServerStatus()`; `canUseTool(toolName, input, { signal, suggestions })` → `{ behavior: "allow" | "deny", ... }`; `createSdkMcpServer({ name, tools })` + `tool(name, description, zodShape, handler)`; hooks as `Partial<Record<HookEvent, HookCallbackMatcher[]>>` with `PostToolUse` → `hookSpecificOutput.additionalContext` and `Stop` → `last_assistant_message`. Result subtypes: `success`, `error_during_execution`, `error_max_turns`, `error_max_budget_usd`, `error_max_structured_output_retries`.
- **PermissionMode** mirrors the SDK's current union: `default | acceptEdits | bypassPermissions | plan | dontAsk | auto`.
- **Repo name.** The GitHub repo is `grid-commander`; the product and package scope stay `Hex Command` / `@hexcommand/*` as the spec names them.

## M1

- **`start()` does not wait for `system/init`.** Verified against the real SDK (0.3.296): in streaming-input mode the CLI emits `system/init` only after the first user message arrives, so a runtime that waited for init before accepting orders would hang. `start()` resolves once the SDK process is spawned and has not exited within a short grace window (`startGraceMs`, default 1.5 s); status becomes `idle` at that point. `InitInfo` (session id, model, tools, MCP server statuses) is captured on the `init` runtime event when it arrives with the first turn. The status machine is unchanged: `offline → idle` is still driven by the `init` event; the runtime simply fires it on spawn.
- **`rate_limit_event` is informational.** The SDK emits one on every turn with `rate_limit_info.status`; only a non-`allowed` status produces an operator notice.
- **Type-only SDK imports** live in `src/runtime/sdkTypes.ts` so the fake SDK and tests share shapes; types are erased so the single-runtime-import rule in CLAUDE.md still holds for runtime code.
- **AskUserQuestion is answered through `canUseTool`:** the runtime returns `{ behavior: "allow", updatedInput: { ...input, answers } }`, which is how the SDK expects hosts to answer. The spec's "assistant calls AskUserQuestion → waiting" is satisfied because the permission callback fires at that moment.
- **Interrupt during a permission wait** uses the SDK's `{ behavior: "deny", interrupt: true }` escape hatch and then `interrupt()`; the turn resolves as interrupted.
