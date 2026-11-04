#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadConfig } from "./config.ts";
import { type HookPayload, denyOutput, evaluate, isSimulatorTool } from "./hook.ts";
import { agentSession, ancestry, claimantOwner, defaultLabel, resolveOwner } from "./owner.ts";
import { DRIVERS } from "./platforms/index.ts";
import { type Holding, Pool, SimpoolError, describeLease } from "./pool.ts";
import { type Agent, setup } from "./setup.ts";

const USAGE = `simpool — lease simulators to parallel AI agents

Usage:
  simpool lease <platform> [<identity>] [--label <name>] [--agent <name>] [--json] [--no-boot]
  simpool challenge <slot> [<identity>] [--json]
  simpool renew [<identity>]
  simpool release [<identity>] [--slot <slot> [--force]] [--shutdown]
  simpool status [--json]
  simpool gc
  simpool setup [--claude] [--codex] [--no-hook] [--remove] [--dry-run]
  simpool hook                      (PreToolUse hook; reads the payload on stdin)

Identity (who holds the lease; at most one):
  --worktree <path>   a git worktree (default: the one containing the current directory)
  --pid <pid>         a process, e.g. the agent's: --pid "$CLAUDE_PID"
  --session <id>      an agent session id
  --id <string>       any name; also read from SIMPOOL_ID, which the hook checks too

Platforms: ${DRIVERS.map((d) => d.name).join(", ")}

lease and challenge print the device id on stdout (iOS: UDID, Android: emulator
serial); everything else goes to stderr.
Exit code 3 means refused: the pool is full or the holder is still live.`;

function info(line: string): void {
  console.error(line);
}

function printHolding(holding: Holding, json: boolean): void {
  if (holding.reclaimed) {
    info(`♻️  Reclaimed ${describeLease(holding.slot, holding.reclaimed.lease, Date.now())}: ${holding.reclaimed.reason}`);
  }
  info(`🔒 ${holding.slot} for "${holding.lease.label}" — port ${holding.port}`);
  if (json) {
    const driver = DRIVERS.find((d) => holding.slot.startsWith(`${d.name}-`));
    const extra = driver?.describe(holding.id, holding.aliases) ?? {};
    console.log(
      JSON.stringify({ slot: holding.slot, id: holding.id, ...extra, port: holding.port, label: holding.lease.label }),
    );
  } else {
    console.log(holding.id);
  }
}

function runHook(pool: Pool): void {
  let payload: HookPayload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8")) as HookPayload;
  } catch {
    return;
  }
  if (!isSimulatorTool(payload.tool_name ?? "", DRIVERS)) return;
  try {
    let ancestors: Set<string> | undefined;
    const caller = {
      owner: resolveOwner(payload.cwd ?? process.cwd()),
      session: payload.session_id,
      id: process.env.SIMPOOL_ID || undefined,
      // The hook runs as a child of the agent, so the agent's pid is among our ancestors.
      ancestors: () => (ancestors ??= ancestry()),
    };
    const reason = evaluate(payload, pool, caller, DRIVERS);
    if (reason) console.log(denyOutput(`simpool: ${reason}`));
  } catch (error) {
    // Fail open: a broken pool must not block every shell command.
    info(`simpool hook error: ${(error as Error).message}`);
  }
}

function main(argv: string[]): void {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      label: { type: "string" },
      agent: { type: "string" },
      worktree: { type: "string" },
      pid: { type: "string" },
      session: { type: "string" },
      id: { type: "string" },
      slot: { type: "string" },
      json: { type: "boolean" },
      "no-boot": { type: "boolean" },
      force: { type: "boolean" },
      shutdown: { type: "boolean" },
      claude: { type: "boolean" },
      codex: { type: "boolean" },
      remove: { type: "boolean" },
      "no-hook": { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const config = loadConfig(DRIVERS);
  const backends = Object.fromEntries(
    DRIVERS.map((d) => [d.name, d.open(config.platforms[d.name] ?? d.defaults, config.home)]),
  );
  const pool = new Pool(config, backends);
  if (command === "hook") return runHook(pool);

  let owner: string;
  try {
    owner = claimantOwner(
      { worktree: values.worktree, pid: values.pid, session: values.session, id: values.id },
      process.env,
      process.cwd(),
    );
  } catch (error) {
    throw new SimpoolError((error as Error).message);
  }
  const claimant = {
    owner,
    label: values.label ?? defaultLabel(resolveOwner(values.worktree ?? process.cwd())),
    agent: values.agent ?? process.env.SIMPOOL_AGENT,
    // Recorded so the hook recognises this session even after it cd's elsewhere. Without
    // one, the hook fills in the session id on the first simulator call it allows.
    session: values.session ?? agentSession(process.env),
  };

  switch (command) {
    case "lease": {
      const platform = arg ?? "ios";
      printHolding(pool.lease(platform, claimant, { boot: !values["no-boot"] }), values.json ?? false);
      return;
    }
    case "challenge": {
      if (!arg) throw new SimpoolError("Usage: simpool challenge <slot>");
      printHolding(pool.challenge(arg, claimant), values.json ?? false);
      return;
    }
    case "renew": {
      const slots = pool.renew(owner);
      info(slots.length ? `Renewed ${slots.join(", ")}` : "Nothing leased from this worktree.");
      return;
    }
    case "release": {
      const slots = pool.release(owner, { slot: values.slot, force: values.force, shutdown: values.shutdown });
      info(slots.length ? `Released ${slots.join(", ")}` : "Nothing to release.");
      return;
    }
    case "gc": {
      const reaped = pool.gc();
      for (const { slot, lease, reason } of reaped) info(`♻️  ${describeLease(slot, lease, Date.now())}: ${reason}`);
      if (reaped.length === 0) info("No stale leases.");
      return;
    }
    case "status": {
      const rows = pool.status();
      if (values.json) {
        console.log(JSON.stringify(rows, null, 2));
        return;
      }
      const now = Date.now();
      for (const row of rows) {
        const device = row.id ? `${row.id} [${row.deviceState ?? "missing"}]` : "not created yet";
        if (!row.lease) {
          console.log(`${row.slot}  free  ${device}`);
          continue;
        }
        const stale = row.stale ? `  ⚠️ stale: ${row.stale}` : "";
        console.log(`${describeLease(row.slot, row.lease, now)}, port ${row.lease.port}${stale}\n    ${device}`);
      }
      return;
    }
    case "setup": {
      const picked: Agent[] = [];
      if (values.claude) picked.push("claude");
      if (values.codex) picked.push("codex");
      setup({
        agents: picked.length ? picked : ["claude", "codex"],
        hook: !values["no-hook"],
        remove: values.remove,
        dryRun: values["dry-run"],
      });
      return;
    }
    default:
      throw new SimpoolError(`Unknown command "${command}".\n\n${USAGE}`);
  }
}

try {
  main(process.argv.slice(2));
} catch (error) {
  info(error instanceof SimpoolError ? error.message : `simpool: ${(error as Error).message}`);
  process.exit(error instanceof SimpoolError ? error.exitCode : 1);
}
