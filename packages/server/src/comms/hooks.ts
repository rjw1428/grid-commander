import type { HookCallbackMatcher, HookEvent } from "../runtime/sdkTypes.js";
import type { CommsBroker } from "./CommsBroker.js";

/** SDK hook callbacks for one unit: the PostToolUse inbox nudge. Stop capture lives in UnitRuntime. */
export function hooksForUnit(unitId: string, broker: CommsBroker): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
  return {
    PostToolUse: [
      {
        hooks: [
          async () => {
            const ctx = broker.nudge(unitId);
            if (!ctx) return { continue: true };
            return { continue: true, hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: ctx } };
          },
        ],
      },
    ],
  };
}
