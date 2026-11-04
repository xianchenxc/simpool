import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatEvent, logEvent, parseSince, readEvents } from "../src/events.ts";
import { EXIT_REFUSED, SimpoolError } from "../src/pool.ts";
import { MINUTE, fixture } from "./helpers.ts";

test("logEvent appends, truncates long commands and skips torn lines on read", () => {
  const home = mkdtempSync(join(tmpdir(), "simpool-events-"));
  logEvent(home, { t: 1, event: "deny", command: "x".repeat(1000), reason: "nope" });
  writeFileSync(join(home, "events.jsonl"), '{"t":2,"ev', { flag: "a" });
  writeFileSync(join(home, "events.jsonl"), "\n", { flag: "a" });
  logEvent(home, { t: 3, event: "gc", slot: "ios-1" });

  const events = readEvents(home);
  assert.deepEqual(events.map((e) => e.t), [1, 3]);
  assert.equal(events[0]?.command?.length, 300);
});

test("logEvent never throws when the home cannot be written", () => {
  const home = join(mkdtempSync(join(tmpdir(), "simpool-events-")), "file");
  writeFileSync(home, "not a directory");
  assert.doesNotThrow(() => logEvent(home, { t: 1, event: "lease" }));
  rmSync(home);
});

test("parseSince reads minutes, hours and days", () => {
  assert.deepEqual([parseSince("30m"), parseSince("6h"), parseSince("2d")], [30 * MINUTE, 360 * MINUTE, 2880 * MINUTE]);
  assert.throws(() => parseSince("yesterday"), /30m, 6h or 2d/);
});

test("formatEvent shows who and why on one line", () => {
  const line = formatEvent({
    t: new Date(2026, 10, 4, 21, 3, 7).getTime(),
    event: "deny",
    owner: "/repo/.claude/worktrees/feat-x",
    command: "adb   install\n app.apk",
    reason: "Target your emulator",
  });
  assert.equal(line, "11-04 21:03:07  deny      -          feat-x  Target your emulator · $ adb install app.apk");
});

test("the pool logs leases, renewals, reclaims, refusals, releases and device creation", () => {
  const { pool, clock, home, worktree } = fixture({ platforms: { ios: { size: 1, portBase: 8081 } } });
  const a = worktree("a");
  pool.lease("ios", { owner: a, label: "a" });
  pool.lease("ios", { owner: a, label: "a" });
  assert.throws(
    () => pool.lease("ios", { owner: worktree("b"), label: "b" }),
    (error: unknown) => error instanceof SimpoolError && error.exitCode === EXIT_REFUSED,
  );
  clock.now += 61 * MINUTE;
  const c = worktree("c");
  pool.lease("ios", { owner: c, label: "c" });
  pool.release(c);

  const events = readEvents(home).map((e) => [e.event, e.slot ?? e.platform, e.label, e.from, e.reason]);
  assert.deepEqual(events, [
    ["create", "ios-1", undefined, undefined, undefined],
    ["lease", "ios-1", "a", undefined, undefined],
    ["renew", "ios-1", "a", undefined, undefined],
    ["refuse", "ios", "b", undefined, "pool full"],
    ["reclaim", "ios-1", "c", "a", "idle 61 min"],
    ["lease", "ios-1", "c", undefined, undefined],
    ["release", "ios-1", "c", undefined, undefined],
  ]);
});
