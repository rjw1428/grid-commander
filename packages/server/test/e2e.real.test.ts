/**
 * Opt-in integration test against the real Agent SDK. Needs a Claude login or ANTHROPIC_API_KEY.
 *   FLEET_E2E=1 pnpm --filter @hexcommand/server test -- e2e
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UnitStatus } from "@hexcommand/shared";
import { UnitRuntime, realSdk } from "../src/runtime/UnitRuntime.js";

const E2E = process.env.FLEET_E2E === "1";

describe.skipIf(!E2E)("real SDK (FLEET_E2E=1)", () => {
  it(
    "haiku unit completes a trivial prompt: offline → idle → working → done",
    async () => {
      const cwd = mkdtempSync(join(tmpdir(), "hexcommand-e2e-"));
      const rt = new UnitRuntime(
        {
          unitId: "e2e-1",
          cwd,
          model: "haiku",
          permissionMode: "default",
          systemPromptAppend: "You are a test unit. Follow the instruction literally.",
          settingSources: [],
        },
        realSdk,
      );
      const statuses: UnitStatus[] = [rt.status];
      rt.on("status", (s) => statuses.push(s));
      await rt.start();
      expect(rt.status).toBe("idle");
      const r = await rt.submit("Reply with the word ready and nothing else.", "operator");
      expect(r.ok).toBe(true);
      expect(r.text.toLowerCase()).toContain("ready");
      expect(rt.sessionId).toMatch(/[0-9a-f-]{20,}/);
      expect(rt.initInfo?.model).toMatch(/haiku/);
      expect(statuses).toEqual(["offline", "idle", "working", "done"]);
      const sid = rt.sessionId;
      await rt.stop();
      expect(rt.status).toBe("offline");
      expect(rt.sessionId).toBe(sid);
    },
    180_000,
  );
});
