import type { Caller } from "./owner.ts";
import type { PlatformDriver } from "./platforms/driver.ts";
import type { Pool } from "./pool.ts";

/** The PreToolUse payload shared by Claude Code and Codex. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** MCP tools that drive devices: `mcp__<server>__<tool>` with a driver keyword in it. */
export function mcpPattern(drivers: PlatformDriver[]): RegExp {
  const keywords = drivers.flatMap((d) => d.mcp.keywords);
  return new RegExp(`^mcp__.*(${keywords.join("|")})`, "i");
}

export function isSimulatorTool(toolName: string, drivers: PlatformDriver[]): boolean {
  return toolName === "Bash" || mcpPattern(drivers).test(toolName);
}

function checkShell(command: string, pool: Pool, caller: Caller, drivers: PlatformDriver[]): string | undefined {
  for (const driver of drivers) {
    const rules = driver.shell;
    if (!rules.trigger.test(command)) continue;
    const forbidden = rules.forbidden?.(command);
    if (forbidden) return forbidden;
    const known = pool.knownIds(driver.name);
    const refs = [...new Set(rules.refs(command))].filter((ref) => known.has(ref));
    for (const ref of refs) {
      const result = pool.authorize(caller, ref, driver.name);
      if (!result.ok) return result.reason;
    }
    if (refs.length === 0) {
      const missing = rules.missingDevice?.(command);
      if (missing) return missing;
    }
  }
  return undefined;
}

function checkMcp(
  toolName: string,
  input: Record<string, unknown>,
  pool: Pool,
  caller: Caller,
  drivers: PlatformDriver[],
): string | undefined {
  const fields = [...new Set(drivers.flatMap((d) => d.mcp.fields))];
  const field = fields.find((name) => typeof input[name] === "string" && input[name] !== "");
  if (!field) {
    const needsDevice = drivers.find((d) => d.mcp.needsDevice?.[toolName])?.mcp.needsDevice?.[toolName];
    const hint = "Run `simpool lease <platform>` and use the id it prints.";
    return needsDevice?.(input) ? `Pass \`device\` explicitly. ${hint}` : undefined;
  }
  const result = pool.authorize(caller, input[field] as string);
  return result.ok ? undefined : result.reason;
}

/** Returns a deny reason, or undefined to let the tool call through. */
export function evaluate(
  payload: HookPayload,
  pool: Pool,
  caller: Caller,
  drivers: PlatformDriver[],
): string | undefined {
  const toolName = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  if (toolName === "Bash") {
    return checkShell(String(input.command ?? ""), pool, caller, drivers);
  }
  if (mcpPattern(drivers).test(toolName)) {
    return checkMcp(toolName, input, pool, caller, drivers);
  }
  return undefined;
}

export function denyOutput(reason: string): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason,
    },
  });
}
