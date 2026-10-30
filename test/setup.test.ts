import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { HOOK_MATCHER, mergeHooks, setup } from "../src/setup.ts";

test("mergeHooks keeps other hooks and replaces an older simpool entry", () => {
  const other = { matcher: "Bash", hooks: [{ type: "command", command: "audit.sh" }] };
  const old = { matcher: "Bash", hooks: [{ type: "command", command: "simpool hook" }] };
  const merged = mergeHooks({ model: "x", hooks: { PreToolUse: [other, old], SessionStart: [] } }, "simpool hook");

  assert.equal(merged.model, "x");
  assert.deepEqual(merged.hooks?.SessionStart, []);
  assert.deepEqual(merged.hooks?.PreToolUse, [
    other,
    { matcher: HOOK_MATCHER, hooks: [{ type: "command", command: "simpool hook", timeout: 10 }] },
  ]);
  assert.deepEqual(mergeHooks(merged, undefined).hooks?.PreToolUse, [other]);
});

test("the matcher covers Bash and simulator MCP tools only", () => {
  const re = new RegExp(HOOK_MATCHER);
  for (const name of ["Bash", "mcp__Claude_Code_iOS_Simulator__control", "mcp__XcodeBuildMCP__build_run_sim", "mcp__ios-simulator__ui_tap"]) {
    assert.ok(re.test(name), name);
  }
  for (const name of ["Read", "Edit", "mcp__github__create_pr", "BashOutput"]) {
    assert.ok(!re.test(name), name);
  }
});

test("setup installs skills and hooks for both agents and is idempotent", () => {
  const home = mkdtempSync(join(tmpdir(), "simpool-home-"));
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ theme: "dark" }));
  const log: string[] = [];

  setup({ agents: ["claude", "codex"], home, log: (l) => log.push(l) });
  setup({ agents: ["claude", "codex"], home, log: (l) => log.push(l) });

  const claude = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  const codex = JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
  assert.equal(claude.theme, "dark");
  assert.equal(claude.hooks.PreToolUse.length, 1);
  assert.equal(codex.hooks.PreToolUse.length, 1);
  assert.match(readFileSync(join(home, ".agents", "skills", "simpool", "SKILL.md"), "utf8"), /name: simpool/);
  assert.match(readFileSync(join(home, ".claude", "skills", "simpool", "SKILL.md"), "utf8"), /name: simpool/);
  assert.ok(log.some((l) => l.includes("already up to date")));
  assert.ok(log.some((l) => l.includes("/hooks")));

  setup({ agents: ["claude", "codex"], home, remove: true, log: () => {} });
  const removed = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
  assert.equal(removed.hooks.PreToolUse, undefined);
});
