#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { type Platform, loadConfig } from "./config.ts";
import { type HookPayload, denyOutput, evaluate, isSimulatorTool } from "./hook.ts";
import { defaultLabel, resolveOwner } from "./owner.ts";
import { type Holding, Pool, SimpoolError, describeLease } from "./pool.ts";
import { type Agent, setup } from "./setup.ts";
import { Simctl } from "./simctl.ts";

const USAGE = `simpool — lease simulators to parallel AI agents

Usage:
  simpool lease ios [--label <name>] [--agent <name>] [--json] [--no-boot]
  simpool challenge <slot> [--json]
  simpool renew
  simpool release [--slot <slot> [--force]] [--shutdown]
  simpool status [--json]
  simpool gc
  simpool setup [--claude] [--codex] [--remove] [--dry-run]
  simpool hook                      (PreToolUse hook; reads the payload on stdin)

lease and challenge print the UDID on stdout; everything else goes to stderr.
Exit code 3 means refused: the pool is full or the holder is still live.`;

const PLATFORMS: Platform[] = ["ios"];

function info(line: string): void {
  console.error(line);
}

function printHolding(holding: Holding, json: boolean): void {
  if (holding.reclaimed) {
    info(`♻️  Reclaimed ${describeLease(holding.slot, holding.reclaimed.lease, Date.now())}: ${holding.reclaimed.reason}`);
  }
  info(`🔒 ${holding.slot} for "${holding.lease.label}" — port ${holding.port}`);
  if (json) {
    console.log(JSON.stringify({ slot: holding.slot, udid: holding.udid, port: holding.port, label: holding.lease.label }));
  } else {
    console.log(holding.udid);
  }
}

function runHook(pool: Pool): void {
  let payload: HookPayload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8")) as HookPayload;
  } catch {
    return;
  }
  if (!isSimulatorTool(payload.tool_name ?? "")) return;
  try {
    const owner = resolveOwner(payload.cwd ?? process.cwd());
    const reason = evaluate(payload, pool, owner);
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
      slot: { type: "string" },
      json: { type: "boolean" },
      "no-boot": { type: "boolean" },
      force: { type: "boolean" },
      shutdown: { type: "boolean" },
      claude: { type: "boolean" },
      codex: { type: "boolean" },
      remove: { type: "boolean" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  if (!command || values.help) {
    console.log(USAGE);
    return;
  }

  const pool = new Pool(loadConfig(), new Simctl());
  if (command === "hook") return runHook(pool);

  const owner = resolveOwner(process.cwd());
  const claimant = {
    owner,
    label: values.label ?? defaultLabel(owner),
    agent: values.agent ?? process.env.SIMPOOL_AGENT,
    // The hook fills in the real session id on the first simulator call.
    session: process.env.SIMPOOL_SESSION,
  };

  switch (command) {
    case "lease": {
      const platform = (arg ?? "ios") as Platform;
      if (!PLATFORMS.includes(platform)) throw new SimpoolError(`Unknown platform "${arg}". Supported: ${PLATFORMS.join(", ")}.`);
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
        const device = row.udid ? `${row.udid} [${row.deviceState ?? "missing"}]` : "not created yet";
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
