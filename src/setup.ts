import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Agent = "claude" | "codex";

interface AgentTarget {
  /** File holding the agent's user-level hooks. */
  hooksFile: string;
  skillDir: string;
  note?: string;
}

/** Same regex works for both agents: Claude and Codex name the shell tool `Bash`. */
export const HOOK_MATCHER = "^(Bash|mcp__.*([Ss]imulator|[Xx]code|[Ii][Oo][Ss]).*)$";

function targets(home: string): Record<Agent, AgentTarget> {
  return {
    claude: {
      hooksFile: join(home, ".claude", "settings.json"),
      skillDir: join(home, ".claude", "skills", "simpool"),
    },
    codex: {
      hooksFile: join(home, ".codex", "hooks.json"),
      skillDir: join(home, ".agents", "skills", "simpool"),
      note: "Codex runs new hooks only after you trust them: open Codex and review them with /hooks.",
    },
  };
}

const SKILL_SOURCE = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "simpool", "SKILL.md");

interface HookEntry {
  matcher?: string;
  hooks?: { type?: string; command?: string; timeout?: number }[];
}

interface HooksDoc {
  hooks?: Record<string, HookEntry[] | undefined>;
  [key: string]: unknown;
}

function isSimpoolEntry(entry: HookEntry): boolean {
  // Matches both `simpool hook` and `"/path/to/node" "/…/simpool/dist/cli.js" hook`.
  return (entry.hooks ?? []).some((h) => /simpool/.test(h.command ?? "") && /\shook$/.test(h.command ?? ""));
}

/** `simpool hook` when simpool is on PATH, otherwise an absolute node + script path. */
export function hookCommand(): string {
  try {
    execFileSync("sh", ["-c", "command -v simpool"], { stdio: "ignore" });
    return "simpool hook";
  } catch {
    const cli = join(dirname(fileURLToPath(import.meta.url)), "cli.js");
    return `"${process.execPath}" "${cli}" hook`;
  }
}

export function mergeHooks(doc: HooksDoc, command: string | undefined): HooksDoc {
  const hooks = { ...(doc.hooks ?? {}) };
  const kept = (hooks.PreToolUse ?? []).filter((entry) => !isSimpoolEntry(entry));
  if (command) {
    kept.push({ matcher: HOOK_MATCHER, hooks: [{ type: "command", command, timeout: 10 }] });
  }
  if (kept.length > 0) hooks.PreToolUse = kept;
  else delete hooks.PreToolUse;
  return { ...doc, hooks };
}

function readJson(file: string): HooksDoc {
  if (!existsSync(file)) return {};
  return JSON.parse(readFileSync(file, "utf8")) as HooksDoc;
}

export interface SetupOptions {
  agents: Agent[];
  remove?: boolean;
  dryRun?: boolean;
  home?: string;
  log?: (line: string) => void;
}

export function setup(options: SetupOptions): void {
  const log = options.log ?? ((line: string) => console.error(line));
  const all = targets(options.home ?? homedir());
  const command = options.remove ? undefined : hookCommand();

  for (const agent of options.agents) {
    const target = all[agent];
    const before = readJson(target.hooksFile);
    const after = mergeHooks(before, command);
    const changed = JSON.stringify(before) !== JSON.stringify(after);
    const verb = options.dryRun ? "would update" : "updated";

    if (changed) {
      log(`${agent}: ${verb} ${target.hooksFile}`);
      if (!options.dryRun) {
        mkdirSync(dirname(target.hooksFile), { recursive: true });
        if (existsSync(target.hooksFile)) copyFileSync(target.hooksFile, `${target.hooksFile}.simpool-backup`);
        writeFileSync(target.hooksFile, `${JSON.stringify(after, null, 2)}\n`);
      }
    } else {
      log(`${agent}: ${target.hooksFile} already up to date`);
    }

    if (options.remove) {
      log(`${agent}: ${options.dryRun ? "would remove" : "removed"} ${target.skillDir}`);
      if (!options.dryRun) rmSync(target.skillDir, { recursive: true, force: true });
    } else {
      log(`${agent}: ${options.dryRun ? "would install" : "installed"} skill in ${target.skillDir}`);
      if (!options.dryRun) {
        mkdirSync(target.skillDir, { recursive: true });
        copyFileSync(SKILL_SOURCE, join(target.skillDir, "SKILL.md"));
      }
      if (target.note && changed) log(`${agent}: ${target.note}`);
    }
  }
}
