import { describe, expect, it } from "vitest";
import {
  activityFromBlocks,
  describeToolUse,
  displayToolName,
  summarizeInput,
  summarizePermission,
  transcriptFromAssistantBlocks,
} from "../src/runtime/activity.js";

describe("activity", () => {
  it("describes tool uses per spec", () => {
    const long = describeToolUse("Bash", { command: "gradle test --info --stacktrace --no-daemon --rerun-tasks" });
    expect(long.startsWith("Bash: gradle test --info")).toBe(true);
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual("Bash: ".length + 40);
    expect(describeToolUse("Bash", { command: "ls" })).toBe("Bash: ls");
    expect(describeToolUse("Edit", { file_path: "/a/b/Foo.java" })).toBe("Edit: Foo.java");
    expect(describeToolUse("Read", { file_path: "/a/b/c.ts" })).toBe("Read: c.ts");
    expect(describeToolUse("Grep", { pattern: "TODO" })).toBe("Grep: TODO");
    expect(describeToolUse("Agent", { description: "find flaky tests" })).toBe("Agent: find flaky tests");
    expect(describeToolUse("mcp__fleet__fleet_send", { to: "xre-cache", body: "x" })).toBe("fleet_send → xre-cache");
  });
  it("strips mcp prefixes", () => {
    expect(displayToolName("mcp__fleet__fleet_inbox")).toBe("fleet_inbox");
    expect(displayToolName("mcp__my_server__do_thing")).toBe("do_thing");
    expect(displayToolName("Bash")).toBe("Bash");
  });
  it("last block wins for activity", () => {
    expect(activityFromBlocks([{ type: "thinking" }, { type: "text", text: "hi" }])).toBe("Writing");
    expect(activityFromBlocks([{ type: "text", text: "hi" }, { type: "tool_use", id: "1", name: "Bash", input: { command: "ls" } }])).toBe(
      "Bash: ls",
    );
    expect(activityFromBlocks([{ type: "text", text: "   " }])).toBeUndefined();
  });
  it("transcript merges text and lists tools", () => {
    const entries = transcriptFromAssistantBlocks(
      [
        { type: "text", text: "a" },
        { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/x/y.ts" } },
        { type: "text", text: "b" },
      ],
      1,
    );
    expect(entries).toEqual([
      { kind: "assistant", at: 1, text: "a\n\nb" },
      { kind: "tool", at: 1, name: "Write", summary: "Write: y.ts", toolUseId: "t1" },
    ]);
  });
  it("permission summaries and input truncation", () => {
    expect(summarizePermission("Bash", { command: "rm -rf build" })).toBe("Run: rm -rf build");
    expect(summarizePermission("Write", { file_path: "/p/q" })).toBe("Write /p/q");
    const big = "x".repeat(1000);
    const s = summarizeInput({ content: big, nested: { more: big }, n: 1 });
    expect((s.content as string).length).toBeLessThan(450);
    expect(((s.nested as Record<string, unknown>).more as string).length).toBeLessThan(450);
    expect(s.n).toBe(1);
  });
});
