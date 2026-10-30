import type { Pool } from "./pool.ts";

/** The PreToolUse payload shared by Claude Code and Codex. */
export interface HookPayload {
  session_id?: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

const SHELL_TRIGGER = /\bsimctl\b|\bxcodebuild\b|\brun:ios\b|\brun-ios\b/;
const SIMCTL_BOOTED = /\bsimctl\s+(?!list\b)[^|;&]*\bbooted\b/;
const RUN_IOS = /\brun:ios\b|\brun-ios\b/;
const UUID = /\b[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}\b/gi;

/** MCP servers that drive simulators: Claude's built-in one, XcodeBuildMCP, ios-simulator-mcp, … */
const SIMULATOR_MCP = /^mcp__.*(simulator|xcode|ios)/i;
const DEVICE_FIELDS = ["device", "udid", "simulatorId", "simulatorUuid", "simulatorUDID", "simulatorName", "deviceId"];

/** Tools that silently fall back to "the booted simulator" when no device is given. */
const NEEDS_DEVICE: Record<string, (input: Record<string, unknown>) => boolean> = {
  mcp__Claude_Code_iOS_Simulator__control: (input) => input.action !== "detach",
};

const LEASE_HINT = "Run `simpool lease ios` and use the UDID it prints.";

export function isSimulatorTool(toolName: string): boolean {
  return toolName === "Bash" || SIMULATOR_MCP.test(toolName);
}

function checkShell(command: string, pool: Pool, owner: string, session?: string): string | undefined {
  if (!SHELL_TRIGGER.test(command)) return undefined;
  if (SIMCTL_BOOTED.test(command)) {
    return `\`booted\` can resolve to another agent's simulator. ${LEASE_HINT}`;
  }
  const known = pool.knownUdids();
  const udids = [...new Set((command.match(UUID) ?? []).map((u) => u.toUpperCase()))].filter((u) =>
    known.has(u),
  );
  for (const udid of udids) {
    const result = pool.authorize(owner, udid, session);
    if (!result.ok) return result.reason;
  }
  if (udids.length > 0) return undefined;
  if (RUN_IOS.test(command)) {
    return `Pass your simulator explicitly, e.g. \`expo run:ios --device <udid>\`. ${LEASE_HINT}`;
  }
  if (/\bxcodebuild\b/.test(command) && /\btest\b/.test(command) && /platform=iOS Simulator/.test(command)) {
    return `Target your simulator with \`-destination 'id=<udid>'\`. ${LEASE_HINT}`;
  }
  return undefined;
}

function checkMcp(
  toolName: string,
  input: Record<string, unknown>,
  pool: Pool,
  owner: string,
  session?: string,
): string | undefined {
  const field = DEVICE_FIELDS.find((name) => typeof input[name] === "string" && input[name] !== "");
  if (!field) {
    return NEEDS_DEVICE[toolName]?.(input) ? `Pass \`device\` explicitly. ${LEASE_HINT}` : undefined;
  }
  const result = pool.authorize(owner, input[field] as string, session);
  return result.ok ? undefined : result.reason;
}

/** Returns a deny reason, or undefined to let the tool call through. */
export function evaluate(payload: HookPayload, pool: Pool, owner: string): string | undefined {
  const toolName = payload.tool_name ?? "";
  const input = payload.tool_input ?? {};
  if (toolName === "Bash") {
    return checkShell(String(input.command ?? ""), pool, owner, payload.session_id);
  }
  if (SIMULATOR_MCP.test(toolName)) {
    return checkMcp(toolName, input, pool, owner, payload.session_id);
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
