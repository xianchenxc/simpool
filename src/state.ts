import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "./config.ts";

export interface Slot {
  platform: Platform;
  udid: string;
}

export interface Lease {
  /** Worktree (git toplevel) that holds the device. */
  owner: string;
  label: string;
  agent?: string;
  session?: string;
  port: number;
  leasedAt: number;
  renewedAt: number;
}

export interface State {
  version: 1;
  /** Slot id ("ios-1") → the simulator backing it. Survives releases. */
  slots: Record<string, Slot>;
  /** Slot id → current holder. */
  leases: Record<string, Lease>;
}

const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 20_000;

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** mkdir is atomic on every filesystem we care about, unlike flock in Node. */
function acquireLock(dir: string): () => void {
  const started = Date.now();
  for (;;) {
    try {
      mkdirSync(dir);
      writeFileSync(join(dir, "pid"), String(process.pid));
      return () => rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let age = 0;
    try {
      age = Date.now() - statSync(dir).mtimeMs;
    } catch {
      continue; // Released between mkdir and stat.
    }
    if (age > LOCK_STALE_MS) {
      rmSync(dir, { recursive: true, force: true });
      continue;
    }
    if (Date.now() - started > LOCK_TIMEOUT_MS) {
      throw new Error(`Timed out waiting for ${dir}; remove it if no simpool process is running.`);
    }
    sleep(50);
  }
}

function emptyState(): State {
  return { version: 1, slots: {}, leases: {} };
}

export function readState(home: string): State {
  try {
    return JSON.parse(readFileSync(join(home, "state.json"), "utf8")) as State;
  } catch {
    return emptyState();
  }
}

/** Runs fn under the pool lock and persists the state only if fn returns normally. */
export function withState<T>(home: string, fn: (state: State) => T): T {
  mkdirSync(home, { recursive: true });
  const release = acquireLock(join(home, "lock"));
  try {
    const state = readState(home);
    const result = fn(state);
    const file = join(home, "state.json");
    writeFileSync(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`);
    renameSync(`${file}.tmp`, file);
    return result;
  } finally {
    release();
  }
}
