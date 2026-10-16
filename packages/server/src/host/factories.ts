import { fleetServer, type ToolResult } from "../comms/fleetTools.js";
import { nudgeHooks } from "../comms/hooks.js";
import { DemoRuntime } from "../runtime/DemoRuntime.js";
import { UnitRuntime, realSdk, type RuntimeLogger, type SdkFacade } from "../runtime/UnitRuntime.js";
import type { HostRuntimeFactory } from "./HostServer.js";

const isToolResult = (v: unknown): v is ToolResult =>
  typeof v === "object" && v !== null && Array.isArray((v as { content?: unknown }).content);

/** Production factory: real SDK; fleet tools and the inbox nudge are bridged back to the hub. */
export function sdkHostFactory(log: RuntimeLogger, sdk: SdkFacade = realSdk): HostRuntimeFactory {
  return (spec, bridge) =>
    new UnitRuntime(
      {
        unitId: spec.unitId,
        cwd: spec.cwd,
        model: spec.model,
        permissionMode: spec.permissionMode,
        sessionId: spec.sessionId,
        systemPromptAppend: spec.systemPromptAppend,
        ...(spec.fleetTools.length
          ? {
              mcpServers: (s) => ({
                fleet: fleetServer(s, spec.fleetTools, async (name, args) => {
                  const v = await bridge.tool(name, args);
                  return isToolResult(v) ? v : { content: [{ type: "text", text: "Error: malformed fleet tool result" }], isError: true };
                }),
              }),
              allowedTools: spec.fleetTools.map((n) => `mcp__fleet__${n}`),
            }
          : {}),
        ...(spec.nudgeHook ? { hooks: nudgeHooks(() => bridge.nudge()) } : {}),
        log,
        ...(process.env.ANTHROPIC_API_KEY ? { env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } } : {}),
      },
      sdk,
    );
}

export function demoHostFactory(speed = 1): HostRuntimeFactory {
  return (spec) =>
    new DemoRuntime({ unitId: spec.unitId, name: spec.name, model: spec.model, permissionMode: spec.permissionMode, sessionId: spec.sessionId, speed });
}
