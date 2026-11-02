import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { basename } from "node:path";

/**
 * Who holds a lease, stored as one string key so leases compare with `===`:
 *   worktree  "/abs/path"            (bare path, as in state files before owner kinds)
 *   pid       "pid:1234@1793600000"  (pid plus start time, so a reused pid never matches)
 *   session   "session:<agent session id>"
 *   id        "id:<any string>"
 */
export type OwnerKind = "worktree" | "pid" | "session" | "id";

export interface OwnerFlags {
  worktree?: string;
  pid?: string;
  session?: string;
  id?: string;
}

/** What the hook knows about the agent making a tool call. */
export interface Caller {
  /** Worktree key derived from the call's cwd. */
  owner: string;
  session?: string;
  /** SIMPOOL_ID in the agent's environment. */
  id?: string;
  /** Pid keys of the caller's process ancestry, computed only when a pid lease needs it. */
  ancestors?: () => Set<string>;
}

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const out = execFileSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out || undefined;
  } catch {
    return undefined;
  }
}

/** A worktree's key: its git toplevel, or the directory itself outside git. */
export function resolveOwner(cwd: string): string {
  return realpathSync(git(cwd, "rev-parse", "--show-toplevel") ?? cwd);
}

export function defaultLabel(owner: string): string {
  return git(owner, "branch", "--show-current") ?? basename(owner);
}

export function ownerKind(key: string): OwnerKind {
  const prefix = key.slice(0, key.indexOf(":"));
  return prefix === "pid" || prefix === "session" || prefix === "id" ? prefix : "worktree";
}

function ownerValue(key: string): string {
  return ownerKind(key) === "worktree" ? key : key.slice(key.indexOf(":") + 1);
}

function pidKey(pid: number, start: number): string {
  return `pid:${pid}@${start}`;
}

/** Start time in epoch seconds, or undefined when the process does not exist. */
export function processStart(pid: number): number | undefined {
  try {
    const started = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const ms = Date.parse(started);
    return started && Number.isFinite(ms) ? ms / 1000 : undefined;
  } catch {
    return undefined;
  }
}

interface ProcessInfo {
  pid: number;
  start: number;
  command: string;
}

/** `pid` and every process above it, nearest first, from one `ps` call. */
function lineage(pid: number): ProcessInfo[] {
  const table = new Map<number, ProcessInfo & { ppid: number }>();
  const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,lstart=,comm="], { encoding: "utf8" });
  // lstart is always five fields ("Mon Nov  2 10:25:06 2026"); comm may contain spaces.
  const row = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/;
  for (const line of out.split("\n")) {
    const match = row.exec(line);
    if (!match) continue;
    const [, id, ppid, started, command] = match as unknown as [string, string, string, string, string];
    table.set(Number(id), { pid: Number(id), ppid: Number(ppid), start: Date.parse(started) / 1000, command });
  }
  const chain: ProcessInfo[] = [];
  for (let current = table.get(pid); current && !chain.includes(current); current = table.get(current.ppid)) {
    chain.push(current);
  }
  return chain;
}

/** Pid keys of `pid` and every process above it. */
export function ancestry(pid: number = process.pid): Set<string> {
  return new Set(lineage(pid).map((p) => pidKey(p.pid, p.start)));
}

/**
 * The session id of the agent this process runs under. Agents started from another
 * agent inherit its variables, so when both Claude's and Codex's are set, the agent
 * nearest in the process tree wins.
 */
export function agentSession(env: NodeJS.ProcessEnv, pid: number = process.pid): string | undefined {
  if (env.SIMPOOL_SESSION) return env.SIMPOOL_SESSION;
  const claude = env.CLAUDE_CODE_SESSION_ID || undefined;
  const codex = env.CODEX_THREAD_ID || env.CODEX_SESSION_ID || undefined;
  if (!claude || !codex) return claude ?? codex;
  try {
    for (const p of lineage(pid)) {
      if (String(p.pid) === env.CLAUDE_PID) return claude;
      if (basename(p.command) === "codex") return codex;
    }
  } catch {
    // No ps: fall through.
  }
  return undefined;
}

/**
 * The claimant's owner key: an explicit flag, else SIMPOOL_ID, else the worktree of cwd.
 * At most one flag may be given.
 */
export function claimantOwner(flags: OwnerFlags, env: NodeJS.ProcessEnv, cwd: string): string {
  const given = (Object.keys(flags) as (keyof OwnerFlags)[]).filter((k) => flags[k] !== undefined);
  if (given.length > 1) throw new Error(`Pick one identity, not ${given.map((k) => `--${k}`).join(" and ")}.`);
  if (flags.pid !== undefined) {
    const pid = Number(flags.pid);
    const start = Number.isInteger(pid) && pid > 0 ? processStart(pid) : undefined;
    if (start === undefined) throw new Error(`No running process with pid ${flags.pid}.`);
    return pidKey(pid, start);
  }
  if (flags.session !== undefined) return `session:${flags.session}`;
  const id = flags.id ?? (flags.worktree === undefined ? env.SIMPOOL_ID : undefined);
  if (id) return `id:${id}`;
  return resolveOwner(flags.worktree ?? cwd);
}

/** Whether the caller of a tool call is the lease holder. */
export function callerHolds(key: string, caller: Caller): boolean {
  switch (ownerKind(key)) {
    case "worktree":
      return key === caller.owner;
    case "session":
      return caller.session !== undefined && ownerValue(key) === caller.session;
    case "id":
      return caller.id !== undefined && ownerValue(key) === caller.id;
    case "pid":
      return caller.ancestors?.().has(key) ?? false;
  }
}

/** Why the owner is gone for good, or undefined while it may still be around (then only the TTL applies). */
export function ownerGone(key: string): string | undefined {
  switch (ownerKind(key)) {
    case "worktree":
      return existsSync(key) ? undefined : "worktree removed";
    case "pid": {
      const [pid, start] = ownerValue(key).split("@").map(Number) as [number, number];
      return processStart(pid) === start ? undefined : `process ${pid} exited`;
    }
    default:
      return undefined;
  }
}

export function describeOwner(key: string): string {
  const kind = ownerKind(key);
  if (kind === "worktree") return key;
  if (kind === "pid") return `process ${ownerValue(key).split("@")[0]}`;
  return `${kind} ${ownerValue(key)}`;
}
