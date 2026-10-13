import { basename } from "node:path";
import type { TranscriptEntry } from "@gridcommander/shared";

/** Minimal structural view of an Anthropic content block; avoids importing SDK types here. */
export type ContentBlock =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking?: string }
  | { type: "redacted_thinking" }
  | { type: "tool_use"; id: string; name: string; input: unknown }
  | { type: "tool_result"; tool_use_id: string; is_error?: boolean; content?: unknown }
  | { type: string; [k: string]: unknown };

const MAX_BASH = 40;

function short(s: unknown, n: number): string {
  if (typeof s !== "string") return "";
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

/** Strip the mcp__server__ prefix so fleet tools read as "fleet_send". */
export function displayToolName(name: string): string {
  const m = /^mcp__[^_]+(?:_[^_]+)*__(.+)$/.exec(name);
  return m?.[1] ?? name;
}

/** "<tool>: <short arg>" per docs/02-domain-model.md. */
export function describeToolUse(name: string, input: unknown): string {
  const inp = (input ?? {}) as Record<string, unknown>;
  const tool = displayToolName(name);
  switch (name) {
    case "Bash":
      return `Bash: ${short(inp.command, MAX_BASH)}`;
    case "Edit":
    case "Write":
    case "Read":
    case "MultiEdit":
    case "NotebookEdit":
      return `${tool}: ${typeof inp.file_path === "string" ? basename(inp.file_path) : ""}`.trim();
    case "Grep":
    case "Glob":
      return `${tool}: ${short(inp.pattern, 50)}`;
    case "Agent":
    case "Task":
      return `${tool}: ${short(inp.description, 60)}`;
    case "WebFetch":
      return `WebFetch: ${short(inp.url, 60)}`;
    case "WebSearch":
      return `WebSearch: ${short(inp.query, 50)}`;
    case "AskUserQuestion":
      return "Asking a question";
    case "TodoWrite":
      return "Updating todos";
    default: {
      if (tool.startsWith("fleet_")) {
        const target = typeof inp.to === "string" ? ` → ${inp.to}` : "";
        return `${tool}${target}`;
      }
      const firstString = Object.values(inp).find((v) => typeof v === "string");
      return firstString ? `${tool}: ${short(firstString, 50)}` : tool;
    }
  }
}

/** Activity line for an assistant message; the last block wins. */
export function activityFromBlocks(blocks: ContentBlock[]): string | undefined {
  let activity: string | undefined;
  for (const b of blocks) {
    if (b.type === "tool_use") activity = describeToolUse(b.name as string, (b as { input: unknown }).input);
    else if (b.type === "text" && (b as { text: string }).text.trim()) activity = "Writing";
    else if (b.type === "thinking" || b.type === "redacted_thinking") activity = "Thinking";
  }
  return activity;
}

/** Transcript entries for an assistant message. Text blocks are merged into one entry. */
export function transcriptFromAssistantBlocks(blocks: ContentBlock[], at: number): TranscriptEntry[] {
  const out: TranscriptEntry[] = [];
  const texts: string[] = [];
  for (const b of blocks) {
    if (b.type === "text") {
      const t = (b as { text: string }).text;
      if (t.trim()) texts.push(t);
    } else if (b.type === "tool_use") {
      const tb = b as { id: string; name: string; input: unknown };
      out.push({
        kind: "tool",
        at,
        name: displayToolName(tb.name),
        summary: describeToolUse(tb.name, tb.input),
        toolUseId: tb.id,
      });
    }
  }
  if (texts.length) out.unshift({ kind: "assistant", at, text: texts.join("\n\n") });
  return out;
}

/** tool_result blocks from a user message → (toolUseId, ok) pairs. */
export function toolResultsFromUserBlocks(blocks: ContentBlock[]): { toolUseId: string; ok: boolean }[] {
  const out: { toolUseId: string; ok: boolean }[] = [];
  for (const b of blocks) {
    if (b.type === "tool_result") {
      const tr = b as { tool_use_id: string; is_error?: boolean };
      out.push({ toolUseId: tr.tool_use_id, ok: !tr.is_error });
    }
  }
  return out;
}

/** Humanised activity for system status-type messages. */
export function activityFromSystem(msg: { subtype?: string; [k: string]: unknown }): string | undefined {
  switch (msg.subtype) {
    case "api_retry": {
      const attempt = msg.attempt as number | undefined;
      const max = msg.max_retries as number | undefined;
      const status = msg.error_status as number | null | undefined;
      return `Retrying API${status ? ` (${status})` : ""}${attempt ? ` ${attempt}/${max ?? "?"}` : ""}`;
    }
    case "status": {
      const s = msg.status as string | null | undefined;
      if (s === "compacting") return "Compacting context";
      return s ? `Status: ${s}` : undefined;
    }
    default:
      return undefined;
  }
}

/** Permission prompt summary: a one-liner for the alert tile and the Approve/Deny card. */
export function summarizePermission(toolName: string, input: Record<string, unknown>): string {
  const inp = input;
  switch (toolName) {
    case "Bash":
      return `Run: ${short(inp.command, 160)}`;
    case "Edit":
    case "MultiEdit":
      return `Edit ${typeof inp.file_path === "string" ? inp.file_path : "file"}`;
    case "Write":
      return `Write ${typeof inp.file_path === "string" ? inp.file_path : "file"}`;
    case "Read":
      return `Read ${typeof inp.file_path === "string" ? inp.file_path : "file"}`;
    case "WebFetch":
      return `Fetch ${short(inp.url, 120)}`;
    default:
      return describeToolUse(toolName, input);
  }
}

/** Truncate string fields so permission requests stay small on the wire. */
export function summarizeInput(input: Record<string, unknown>, max = 400): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") out[k] = v.length > max ? v.slice(0, max) + `… (+${v.length - max} chars)` : v;
    else if (Array.isArray(v)) out[k] = v.length > 20 ? [...v.slice(0, 20), `… +${v.length - 20}`] : v;
    else if (v && typeof v === "object") out[k] = summarizeInput(v as Record<string, unknown>, max);
    else out[k] = v;
  }
  return out;
}
