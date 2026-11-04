import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate } from "../src/hook.ts";
import { DRIVERS } from "../src/platforms/index.ts";
import { fixture } from "./helpers.ts";

function setupTwoAgents() {
  const fx = fixture();
  const a = fx.worktree("a");
  const b = fx.worktree("b");
  const mine = fx.pool.lease("ios", { owner: a, label: "a" });
  const theirs = fx.pool.lease("ios", { owner: b, label: "b" });
  fx.sims.list.push({ id: "AAAAAAAA-0000-0000-0000-000000000099", name: "iPhone 17", state: "Booted", isAvailable: true });
  return { ...fx, a, mine, theirs };
}

const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

test("shell commands without simulator tools pass through", () => {
  const { pool, a } = setupTwoAgents();
  assert.equal(evaluate(bash("pnpm test"), pool, { owner: a }, DRIVERS), undefined);
  assert.equal(evaluate(bash("xcrun simctl list devices booted"), pool, { owner: a }, DRIVERS), undefined);
});

test("simctl booted is denied", () => {
  const { pool, a } = setupTwoAgents();
  assert.match(evaluate(bash("xcrun simctl install booted App.app"), pool, { owner: a }, DRIVERS) ?? "", /booted/);
});

test("simctl on your own UDID passes, on another agent's or a non-pool device is denied", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  assert.equal(evaluate(bash(`xcrun simctl launch ${mine.id} com.app`), pool, { owner: a }, DRIVERS), undefined);
  assert.match(evaluate(bash(`xcrun simctl launch ${theirs.id} com.app`), pool, { owner: a }, DRIVERS) ?? "", /held by "b"/);
  assert.match(
    evaluate(bash("xcrun simctl launch AAAAAAAA-0000-0000-0000-000000000099 com.app"), pool, { owner: a }, DRIVERS) ?? "",
    /not a simpool device/,
  );
});

test("UUIDs that are not simulators are ignored", () => {
  const { pool, a, mine } = setupTwoAgents();
  const cmd = `xcrun simctl get_app_container ${mine.id} com.app data && ls 11111111-2222-3333-4444-555555555555`;
  assert.equal(evaluate(bash(cmd), pool, { owner: a }, DRIVERS), undefined);
});

test("expo run:ios needs an explicit device", () => {
  const { pool, a, mine } = setupTwoAgents();
  assert.match(evaluate(bash("npx expo run:ios"), pool, { owner: a }, DRIVERS) ?? "", /--device/);
  assert.equal(evaluate(bash(`npx expo run:ios --device ${mine.id} --port 8081`), pool, { owner: a }, DRIVERS), undefined);
});

test("Claude simulator MCP: device is required except for detach", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  const control = (input: Record<string, unknown>) => ({
    tool_name: "mcp__Claude_Code_iOS_Simulator__control",
    tool_input: input,
  });
  assert.match(evaluate(control({ action: "screenshot" }), pool, { owner: a }, DRIVERS) ?? "", /Pass `device`/);
  assert.equal(evaluate(control({ action: "detach" }), pool, { owner: a }, DRIVERS), undefined);
  assert.equal(evaluate(control({ action: "tap", device: mine.id }), pool, { owner: a }, DRIVERS), undefined);
  assert.match(evaluate(control({ action: "tap", udid: theirs.id }), pool, { owner: a }, DRIVERS) ?? "", /held by "b"/);
});

test("other simulator MCP servers are checked by their device field", () => {
  const { pool, a, mine, theirs } = setupTwoAgents();
  const call = (simulatorId: string) => ({
    tool_name: "mcp__XcodeBuildMCP__build_run_sim",
    tool_input: { simulatorId },
  });
  assert.equal(evaluate(call(mine.id), pool, { owner: a }, DRIVERS), undefined);
  assert.match(evaluate(call(theirs.id), pool, { owner: a }, DRIVERS) ?? "", /held by "b"/);
  assert.equal(evaluate({ tool_name: "mcp__XcodeBuildMCP__list_sims", tool_input: {} }, pool, { owner: a }, DRIVERS), undefined);
});

function setupTwoAndroidAgents() {
  const fx = fixture();
  const a = fx.worktree("a");
  const b = fx.worktree("b");
  const mine = fx.pool.lease("android", { owner: a, label: "a" });
  const theirs = fx.pool.lease("android", { owner: b, label: "b" });
  fx.emus.list.push(
    { id: "Pixel_10_Pro", name: "Pixel 10 Pro", state: "Unknown", isAvailable: true },
    { id: "emulator-5554", name: "emulator-5554", state: "Booted", isAvailable: true },
  );
  const check = (command: string) => evaluate(bash(command), fx.pool, { owner: a }, DRIVERS);
  return { ...fx, a, mine, theirs, check };
}

test("adb must target your own emulator", () => {
  const { check, mine, theirs } = setupTwoAndroidAgents();
  assert.equal(mine.id, "emulator-5570");
  assert.equal(check(`adb -s ${mine.id} install app.apk`), undefined);
  assert.equal(check(`ANDROID_SERIAL=${mine.id} adb install app.apk`), undefined);
  assert.match(check(`adb -s ${theirs.id} shell input tap 1 1`) ?? "", /held by "b"/);
  assert.match(check("adb -s emulator-5554 install app.apk") ?? "", /not a simpool device/);
  assert.match(check("adb install app.apk") ?? "", /adb -s <serial>/);
  assert.match(check("adb -e shell ls") ?? "", /adb -e/);
});

test("adb on a physical device or without a device passes", () => {
  const { check } = setupTwoAndroidAgents();
  assert.equal(check("adb -s R5CT1234 install app.apk"), undefined);
  assert.equal(check("adb devices -l && adb kill-server"), undefined);
  assert.equal(check("emulator -list-avds"), undefined);
});

test("expo run:android and emulator -avd are checked by AVD name", () => {
  const { check } = setupTwoAndroidAgents();
  assert.match(check("npx expo run:android") ?? "", /--device/);
  assert.equal(check("npx expo run:android --device simpool_android_1 --port 8091"), undefined);
  assert.match(check("npx expo run:android --device simpool_android_2") ?? "", /held by "b"/);
  assert.equal(check("npx react-native run-android --deviceId emulator-5570"), undefined);
  assert.match(check("emulator -avd Pixel_10_Pro") ?? "", /not a simpool device/);
});

test("Android MCP servers are checked by their device field", () => {
  const { pool, a, mine, theirs } = setupTwoAndroidAgents();
  const call = (device: string) => ({ tool_name: "mcp__mobile-mcp__mobile_take_screenshot", tool_input: { device } });
  assert.equal(evaluate(call(mine.id), pool, { owner: a }, DRIVERS), undefined);
  assert.match(evaluate(call(theirs.id), pool, { owner: a }, DRIVERS) ?? "", /held by "b"/);
});

test("a pool device the state does not know yet is named as not leased, not as foreign", () => {
  const fx = fixture();
  const a = fx.worktree("a");
  fx.emus.list.push({
    id: "emulator-5572",
    name: "simpool android-2",
    state: "Shutdown",
    isAvailable: true,
    aliases: ["simpool_android_2"],
  });
  const check = (command: string) => evaluate(bash(command), fx.pool, { owner: a }, DRIVERS);
  assert.match(check("adb -s emulator-5572 install app.apk") ?? "", /^android-2 is not leased to you\. Run `simpool lease android`/);
  assert.match(check("npx expo run:android --device simpool_android_2") ?? "", /android-2 is not leased to you/);
  // A leased device's name works too, and a foreign device is still foreign.
  fx.sims.list.push({ id: "AAAAAAAA-0000-0000-0000-000000000001", name: "🔒 old · simpool ios-3", state: "Booted", isAvailable: true });
  assert.match(check("xcrun simctl launch AAAAAAAA-0000-0000-0000-000000000001 com.app") ?? "", /^ios-3 is not leased to you/);
  fx.emus.list.push({ id: "emulator-5554", name: "emulator-5554", state: "Booted", isAvailable: true });
  assert.match(check("adb -s emulator-5554 install app.apk") ?? "", /not a simpool device/);
});
