import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { basename } from "node:path";

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

/** Leases belong to a worktree: its git toplevel, or the directory itself outside git. */
export function resolveOwner(cwd: string): string {
  return realpathSync(git(cwd, "rev-parse", "--show-toplevel") ?? cwd);
}

export function defaultLabel(owner: string): string {
  return git(owner, "branch", "--show-current") ?? basename(owner);
}
