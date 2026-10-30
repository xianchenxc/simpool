import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/hook.ts";
import { fixture } from "./helpers.ts";

function setupTwoAgents() {
  const fx = fixture();
  const a = fx.worktree("a");
  const b = fx.worktree("b");
  const mine = fx.pool.lease("ios", { owner: a, label: "a" });
  const theirs = fx.pool.lease("ios", { owner: b, label: "b" });
  fx.sims.list.push({ udid: "AAAAAAAA-0000-0000-0000-000000000099", name: "iPhone 17", state: "Booted", isAvailable: true });
  return { ...fx, a, mine, theirs };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

test("shell commands without simulator tools pass through", () => {
  const { pool, a } = setupTwoAgents();
  assert.equal(evaluate(bash("pnpm test"), pool, a), undefined);
  assert.equal(evaluate(bash("xcrun simctl list devices booted"), pool, a), undefined);
});

test("simctl booted is denied", () => {
  const { pool, a } = setupTwoAgents();
  assert.match(evaluate(bash("xcrun simctl install booted App.app"), pool, a) ?? "", /booted/);
});

test("simctl on your own UDID passes, on another agent's or a non-pool device is denied", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  assert.equal(evaluate(bash(`xcrun simctl launch ${mine.udid} com.app`), pool, a), undefined);
  assert.match(evaluate(bash(`xcrun simctl launch ${theirs.udid} com.app`), pool, a) ?? "", /held by "b"/);
  assert.match(
    evaluate(bash("xcrun simctl launch AAAAAAAA-0000-0000-0000-000000000099 com.app"), pool, a) ?? "",
    /not a simpool device/,
  );
});

test("UUIDs that are not simulators are ignored", () => {
  const { pool, a, mine } = setupTwoAgents();
  const cmd = `xcrun simctl get_app_container ${mine.udid} com.app data && ls 11111111-2222-3333-4444-555555555555`;
  assert.equal(evaluate(bash(cmd), pool, a), undefined);
});

test("expo run:ios needs an explicit device", () => {
  const { pool, a, mine } = setupTwoAgents();
  assert.match(evaluate(bash("npx expo run:ios"), pool, a) ?? "", /--device/);
  assert.equal(evaluate(bash(`npx expo run:ios --device ${mine.udid} --port 8081`), pool, a), undefined);
});

test("Claude simulator MCP: device is required except for detach", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  const control = (input: Record<string, unknown>) => ({
    tool_name: "mcp__Claude_Code_iOS_Simulator__control",
    tool_input: input,
  });
  assert.match(evaluate(control({ action: "screenshot" }), pool, a) ?? "", /Pass `device`/);
  assert.equal(evaluate(control({ action: "detach" }), pool, a), undefined);
  assert.equal(evaluate(control({ action: "tap", device: mine.udid }), pool, a), undefined);
  assert.match(evaluate(control({ action: "tap", udid: theirs.udid }), pool, a) ?? "", /held by "b"/);
});

test("other simulator MCP servers are checked by their device field", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  const call = (simulatorId: string) => ({
    tool_name: "mcp__XcodeBuildMCP__build_run_sim",
    tool_input: { simulatorId },
  });
  assert.equal(evaluate(call(mine.udid), pool, a), undefined);
  assert.match(evaluate(call(theirs.udid), pool, a) ?? "", /held by "b"/);
  assert.equal(evaluate({ tool_name: "mcp__XcodeBuildMCP__list_sims", tool_input: {} }, pool, a), undefined);
});
