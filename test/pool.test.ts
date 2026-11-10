import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { EXIT_REFUSED, SimpoolError } from "../src/pool.ts";
import { MINUTE, fixture } from "./helpers.ts";

function refused(fn: () => unknown): void {
  assert.throws(fn, (error: unknown) => error instanceof SimpoolError && error.exitCode === EXIT_REFUSED);
}

test("lease is sticky per worktree and gives each worktree its own device and port", () => {
  const { pool, sims, worktree } = fixture();
  const a = worktree("a");
  const b = worktree("b");

  const first = pool.lease("ios", { owner: a, label: "feat-a" });
  const again = pool.lease("ios", { owner: a, label: "feat-a" });
  const other = pool.lease("ios", { owner: b, label: "feat-b" });

  assert.equal(again.id, first.id);
  assert.notEqual(other.id, first.id);
  assert.deepEqual([first.port, other.port], [8081, 8082]);
  assert.equal(sims.nameOf(first.id), "🔒 feat-a · simpool ios-1");
  assert.ok(sims.booted.includes(first.id));
});

test("a full pool of live leases refuses", () => {
  const { pool, worktree } = fixture();
  pool.lease("ios", { owner: worktree("a"), label: "a" });
  pool.lease("ios", { owner: worktree("b"), label: "b" });
  refused(() => pool.lease("ios", { owner: worktree("c"), label: "c" }));
});

test("a full pool reclaims the lease of a removed worktree after the grace period", () => {
  const { pool, sims, clock, worktree } = fixture();
  const a = worktree("a");
  const held = pool.lease("ios", { owner: a, label: "a" });
  pool.lease("ios", { owner: worktree("b"), label: "b" });
  rmSync(a, { recursive: true });

  refused(() => pool.lease("ios", { owner: worktree("c"), label: "c" }));

  clock.now += 3 * MINUTE;
  const taken = pool.lease("ios", { owner: worktree("c"), label: "c" });
  assert.equal(taken.id, held.id);
  assert.equal(taken.reclaimed?.reason, "worktree removed");
  assert.equal(sims.nameOf(taken.id), "🔒 c · simpool ios-1");
});

test("lease frees an idle lease past the TTL and shuts its device down first", () => {
  const { pool, sims, clock, worktree } = fixture();
  const first = pool.lease("ios", { owner: worktree("a"), label: "a" });
  clock.now += 30 * MINUTE;
  pool.lease("ios", { owner: worktree("b"), label: "b" });
  clock.now += 31 * MINUTE;

  const taken = pool.lease("ios", { owner: worktree("c"), label: "c" });
  assert.equal(taken.slot, "ios-1");
  assert.deepEqual(sims.shutdowns, [first.id]);
});

test("stale leases are freed and their devices shut down even when the pool is not full", () => {
  const { pool, sims, clock, worktree } = fixture({ platforms: { ios: { size: 3, portBase: 8081 } } });
  const gone = pool.lease("ios", { owner: worktree("a"), label: "a" });
  clock.now += 61 * MINUTE;

  // Two slots are still free, yet a's stale lease is freed and its device shut down.
  pool.status();
  assert.equal(pool.status().find((s) => s.slot === "ios-1")?.lease, undefined);
  assert.deepEqual(sims.shutdowns, [gone.id]);
});

test("your own stale lease survives the automatic gc, so you get the same device back", () => {
  const { pool, sims, clock, worktree } = fixture();
  const a = worktree("a");
  const first = pool.lease("ios", { owner: a, label: "a" });
  clock.now += 61 * MINUTE;
  assert.equal(pool.lease("ios", { owner: a, label: "a" }).id, first.id);
  assert.deepEqual(sims.shutdowns, []);
});

test("a free device is shut down once idle past idleShutdownMinutes, at most every few minutes", () => {
  const { pool, sims, clock, worktree } = fixture();
  const a = worktree("a");
  const held = pool.lease("ios", { owner: a, label: "a" });
  pool.release(a, { keepBooted: true });
  assert.deepEqual(sims.shutdowns, []);

  clock.now += 10 * MINUTE;
  pool.status();
  assert.deepEqual(sims.shutdowns, [], "free for 10 min: still warm");

  clock.now += 6 * MINUTE;
  pool.status();
  assert.deepEqual(sims.shutdowns, [held.id], "free for 16 min: shut down");

  // Only booted devices are touched.
  clock.now += 20 * MINUTE;
  pool.gc();
  assert.deepEqual(sims.shutdowns, [held.id]);
});

test("challenge refuses a live holder and takes over a stale one", () => {
  const { pool, clock, worktree } = fixture({ platforms: { ios: { size: 3, portBase: 8081 } } });
  const a = worktree("a");
  const c = worktree("c");
  pool.lease("ios", { owner: a, label: "a" });
  pool.lease("ios", { owner: c, label: "c" });

  refused(() => pool.challenge("ios-1", { owner: c, label: "c" }));

  rmSync(a, { recursive: true });
  clock.now += 3 * MINUTE;
  const taken = pool.challenge("ios-1", { owner: c, label: "c" });
  assert.equal(taken.slot, "ios-1");
  // The challenger's previous device goes back to the pool.
  assert.equal(pool.status().find((s) => s.slot === "ios-2")?.lease, undefined);
});

test("release frees only your own lease unless forced", () => {
  const { pool, sims, worktree } = fixture();
  const a = worktree("a");
  const b = worktree("b");
  const held = pool.lease("ios", { owner: a, label: "a" });

  refused(() => pool.release(b, { slot: "ios-1" }));
  assert.deepEqual(pool.release(b, { slot: "ios-1", force: true }), ["ios-1"]);
  assert.equal(sims.nameOf(held.id), "simpool ios-1");
  assert.deepEqual(pool.release(a), []);
});

test("release shuts the device down unless asked to keep it booted", () => {
  const { pool, sims, emus, worktree } = fixture();
  const a = worktree("a");
  const ios = pool.lease("ios", { owner: a, label: "a" });
  const android = pool.lease("android", { owner: a, label: "a" });
  assert.deepEqual(pool.release(a), ["ios-1", "android-1"]);
  assert.deepEqual([sims.shutdowns, emus.shutdowns], [[ios.id], [android.id]]);

  pool.lease("ios", { owner: a, label: "a" });
  pool.release(a, { keepBooted: true });
  assert.deepEqual(sims.shutdowns, [ios.id]);
});

test("a deleted simulator is recreated for its slot", () => {
  const { pool, sims, worktree } = fixture();
  const a = worktree("a");
  const first = pool.lease("ios", { owner: a, label: "a" });
  pool.release(a);
  sims.list = [];

  const second = pool.lease("ios", { owner: a, label: "a" });
  assert.equal(second.slot, "ios-1");
  assert.notEqual(second.id, first.id);
});

test("authorize accepts slot, UDID and device name, and renews the lease", () => {
  const { pool, clock, worktree } = fixture();
  const a = worktree("a");
  const held = pool.lease("ios", { owner: a, label: "a" });
  clock.now += 50 * MINUTE;

  for (const target of ["ios-1", held.id, "🔒 a · simpool ios-1"]) {
    assert.deepEqual(pool.authorize({ owner: a }, target), { ok: true, slot: "ios-1" });
  }
  clock.now += 50 * MINUTE;
  assert.equal(pool.status()[0]?.stale, undefined);
});

test("android leases get emulator serials, AVD aliases and their own ports", () => {
  const { pool, emus, worktree } = fixture();
  const a = worktree("a");
  const ios = pool.lease("ios", { owner: a, label: "a" });
  const android = pool.lease("android", { owner: a, label: "a" });

  assert.deepEqual([android.slot, android.id, android.aliases, android.port], [
    "android-1",
    "emulator-5570",
    ["simpool_android_1"],
    8091,
  ]);
  assert.equal(ios.port, 8081);
  assert.ok(emus.booted.includes("emulator-5570"));
  assert.deepEqual(pool.authorize({ owner: a }, "simpool_android_1"), { ok: true, slot: "android-1" });
  assert.deepEqual(
    pool.status().map((s) => [s.slot, s.lease?.label]),
    [["ios-1", "a"], ["ios-2", undefined], ["android-1", "a"], ["android-2", undefined]],
  );
  assert.throws(() => pool.lease("windows", { owner: a, label: "a" }), /Unknown platform "windows"/);
});

test("state written before drivers keeps its iOS slots", () => {
  const { pool, sims, worktree } = fixture();
  const a = worktree("a");
  const first = pool.lease("ios", { owner: a, label: "a" });
  const file = join((pool as unknown as { config: { home: string } }).config.home, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8"));
  state.slots["ios-1"] = { platform: "ios", udid: first.id };
  writeFileSync(file, JSON.stringify(state));

  assert.equal(pool.lease("ios", { owner: a, label: "a" }).id, first.id);
  assert.equal(sims.list.length, 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).slots["ios-1"], { platform: "ios", id: first.id });
});
