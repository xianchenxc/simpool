import assert from "node:assert/strict";
import { rmSync } from "node:fs";
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

  assert.equal(again.udid, first.udid);
  assert.notEqual(other.udid, first.udid);
  assert.deepEqual([first.port, other.port], [8081, 8082]);
  assert.equal(sims.nameOf(first.udid), "🔒 feat-a · simpool ios-1");
  assert.ok(sims.booted.includes(first.udid));
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
  assert.equal(taken.udid, held.udid);
  assert.equal(taken.reclaimed?.reason, "worktree removed");
  assert.equal(sims.nameOf(taken.udid), "🔒 c · simpool ios-1");
});

test("a full pool reclaims an idle lease past the TTL", () => {
  const { pool, clock, worktree } = fixture();
  pool.lease("ios", { owner: worktree("a"), label: "a" });
  clock.now += 30 * MINUTE;
  pool.lease("ios", { owner: worktree("b"), label: "b" });
  clock.now += 31 * MINUTE;

  const taken = pool.lease("ios", { owner: worktree("c"), label: "c" });
  assert.equal(taken.slot, "ios-1");
  assert.match(taken.reclaimed?.reason ?? "", /^idle 61 min$/);
});

test("challenge refuses a live holder and takes over a stale one", () => {
  const { pool, clock, worktree } = fixture({ ios: { size: 3, portBase: 8081 } });
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
  assert.equal(sims.nameOf(held.udid), "simpool ios-1");
  assert.deepEqual(pool.release(a), []);
});

test("a deleted simulator is recreated for its slot", () => {
  const { pool, sims, worktree } = fixture();
  const a = worktree("a");
  const first = pool.lease("ios", { owner: a, label: "a" });
  pool.release(a);
  sims.list = [];

  const second = pool.lease("ios", { owner: a, label: "a" });
  assert.equal(second.slot, "ios-1");
  assert.notEqual(second.udid, first.udid);
});

test("authorize accepts slot, UDID and device name, and renews the lease", () => {
  const { pool, clock, worktree } = fixture();
  const a = worktree("a");
  const held = pool.lease("ios", { owner: a, label: "a" });
  clock.now += 50 * MINUTE;

  for (const target of ["ios-1", held.udid, "🔒 a · simpool ios-1"]) {
    assert.deepEqual(pool.authorize({ owner: a }, target), { ok: true, slot: "ios-1" });
  }
  clock.now += 50 * MINUTE;
  assert.equal(pool.status()[0]?.stale, undefined);
});
