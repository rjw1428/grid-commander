# 04 — Agent-to-agent communication

Units talk through the server, never directly. The server is the switchboard and the only authority on who may message whom. A message is delivered to a recipient session as a **user turn** (normal, at a turn boundary) or as an **interrupt followed by a user turn** (urgent). Agents also pull their inbox themselves with a tool.

## Tools available to every unit (in-process MCP server `fleet`)

Built with `createSdkMcpServer({ name: "fleet", tools })` and `tool()` from the Agent SDK, instantiated **per unit** so the unit's identity is closed over; a unit cannot spoof `from`. Tool names as seen by the model are `mcp__fleet__<name>`.

| Tool | Input | Behaviour |
|---|---|---|
| `fleet_roster` | `{ scope?: "project" \| "team" \| "fleet" }` | Returns units the caller may address: id, name, rank, project, status, task, activity. Scope is clamped to the caller type's `commsScope`. The General and Majors see the fleet. |
| `fleet_send` | `{ to: string \| "team" \| "project" \| "general", body: string, priority?: "normal" \| "urgent", replyTo?: string }` | Sends a message. `to` may be a unit id, `"team"` (caller's team), `"project"` (caller's project, excluding self), or `"general"` (any unit of type general). Scope policy enforced; a denied send returns an error explaining the allowed scope and suggesting `"general"`. Returns `{ messageId, threadId, recipients, delivery: "queued" \| "interrupt" }`. `urgent` is allowed only if the caller's type has `canInterrupt: true` (General, Major) **or** the recipient is `idle`/`done` (then urgent is pointless and downgraded). |
| `fleet_inbox` | `{ markRead?: boolean = true }` | Returns undelivered + unread messages for the caller, oldest first, with `from`, `fromRank`, `threadId`, `createdAt`, `body`. Marks them read. |
| `fleet_report` | `{ task?: string, note?: string, done?: boolean }` | Updates the unit's mission line (`task`) and/or posts a one-line progress note to the transcript and to the operator (as an `info` alert when `note` is set); `done: true` marks the mission complete (shows on the map as a flag; does not change status). |
| `fleet_request_review` | `{ summary: string, paths?: string[] }` | Sugar: sends a normal message to the nearest Captain in the caller's project (or the General if none) with a standard review-request template. |

Operator can disable tools per type in `unit-types.json` (`tools: ["fleet_send", ...]`).

## Scope policy

`canSend(from, to)`:

1. Same project → allowed.
2. Same team → allowed.
3. Target is a General → allowed (anyone may escalate).
4. Sender type `commsScope === "fleet"` (General, Major) → allowed.
5. Otherwise denied. Operator may flip a global setting `comms.crossProject: true` to allow everything.

Operator messages (`from: "operator"`) bypass policy.

## Delivery

For each recipient unit R of message M:

- **Normal priority**
  - R `idle` / `done` / `error`: deliver immediately: submit a user turn built from the inbox (see format). Status → `working`. `deliveries[R].how = "turn"`.
  - R `working` / `waiting`: do not interrupt. Stored as unread. Two nudges:
    1. **Hook nudge**: a `PostToolUse` hook callback (SDK `hooks` option) returns `hookSpecificOutput.additionalContext` = `"[fleet] You have N unread messages (from X, Y). Call fleet_inbox when you reach a good stopping point."` at most once per 90 s per unit, and only while unread > 0.
    2. **Turn boundary**: when R reaches `result` (status `done`), and R has unread messages and an empty order queue, the server submits the inbox as the next user turn. Order queue takes priority over inbox; inbox is delivered after queued orders drain unless a message is `urgent`.
  - R `offline`: stored; delivered on next `start`.
- **Urgent priority**
  - R `working`: `interrupt()`; wait for the interrupted `result`; submit the message as a user turn whose first line is `[URGENT message from <name> (<rank>)]`. `how = "interrupt"`. R's previous activity is lost only to the extent Claude Code loses it on any interrupt; the system prompt tells units to pick up where they left off after handling an urgent message.
  - R `waiting` (permission pending): cannot interrupt a permission prompt cleanly. Mark the alert for the operator as `urgent message pending`; deliver as soon as the permission is answered (before resuming) — i.e. the permission answer resolves, then the runtime interrupts and delivers.
  - Otherwise same as normal.
- `fleet_inbox` pulls deliver with `how = "tool"` and mark read; a turn-boundary delivery is skipped for messages already read.

## Message turn format

When the server submits inbox messages as a user turn:

```
[fleet inbox — 2 messages]

1. from xre-plan (Engineer), thread 7f3a, 14:02
   Cache invalidation plan is in docs/cache.md. Please implement the LRU eviction described in §3; keep SessionCache's public API unchanged.

2. from xre-review (Captain), thread 91c0, 14:05, reply-to 7f3a
   Note: PR #418 touched the same file; rebase first.

Reply with fleet_send(replyTo=<thread>) when you have something to report. Then continue your current orders.
```

Keep it plain text; no JSON in prompts.

## Threads

`threadId` = id of the first message; replies carry `replyTo` and inherit `threadId`. The client shows threads in a unit's Messages tab and as arcs on the map (`message.new` WS event → arc from sender hex to recipient hex, 1.6 s, gold for normal, red-orange for urgent, grey for operator-originated).

## Stop hook capture

A `Stop` hook callback stores `last_assistant_message` as the unit's `lastResult.text` (more reliable than waiting for the transcript). If the unit's last turn was an inbox delivery and the text contains no `fleet_send` call, nothing else happens; agents are not forced to reply.

## Etiquette (goes into every unit's appended system prompt)

- You are `<name>`, a `<rank>` on project `<project>`. Other units are listed by `fleet_roster`.
- Send messages only when another unit must act or know something. Prefer one complete message over several partial ones. Lead with the ask.
- Mark a message `urgent` only if the recipient is working on something your message invalidates (wrong branch, broken contract, duplicated work).
- Check `fleet_inbox` at natural stopping points when told you have unread messages.
- Call `fleet_report` when your mission line changes or you hit a milestone; keep it under 80 characters.
- When you finish a mission, say so in one line at the top of your final message, then details.
- Escalate blockers to the General (or Major for merge conflicts); do not wait silently.

## Operator-side

- The operator can message any unit or group (`POST /messages`), with priority. Shown as an arc from the HQ hex (or off-map if no HQ).
- "Relay output" UI action = send a normal message whose body is the source unit's `lastResult.text` (truncated to 2 000 chars) with a header line, from `operator` on behalf of the source; shown as from the source with an `(relayed by operator)` suffix.
- Every message is an `alert` of kind `message` for the operator only when `to` includes a General or when `priority === "urgent"`, to avoid noise. All messages are visible in the Messages tab regardless.
