import type { HookCallbackMatcher, HookEvent } from "../runtime/sdkTypes.js";
import type { CommsBroker } from "./CommsBroker.js";

/** Returns the inbox nudge for a unit (hub side), or undefined when nothing is waiting. */
export type NudgeFn = () => Promise<string | undefined> | string | undefined;

/** SDK hook callbacks for one unit: the PostToolUse inbox nudge. Stop capture lives in UnitRuntime. */
export function nudgeHooks(nudge: NudgeFn): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PostToolUse: [
      {
        hooks: [
          async () => {
            let ctx: string | undefined;
            try {
              ctx = await nudge();
            } catch {
              ctx = undefined; // the hub is unreachable: never block the session on a nudge
            }
            if (!ctx) return { continue: true };
            return { continue: true, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } };
          },
        ],
      },
    ],
  };
}

/** In-process variant bound to the broker. */
export function hooksForUnit(unitId: string, broker: CommsBroker): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return nudgeHooks(() => broker.nudge(unitId));
}
