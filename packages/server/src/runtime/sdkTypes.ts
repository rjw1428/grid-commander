/**
 * Type-only re-exports from the Agent SDK. Types are erased at compile time, so this keeps the
 * single-runtime-import rule (docs/decisions.md) while letting the fake SDK and tests share shapes.
 */
export type {
  CanUseTool,
  HookCallback,
  HookCallbackMatcher,
  HookEvent,
  HookInput,
  HookJSONOutput,
  McpServerConfig,
  Options,
  PermissionMode as SdkPermissionMode,
  PermissionResult,
  PermissionUpdate,
  Query,
  SDKAssistantMessage,
  SDKMessage,
  SDKResultMessage,
  SDKSystemMessage,
  SDKUserMessage,
  StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
