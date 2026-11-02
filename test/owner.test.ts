import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  agentSession,
  ancestry,
  callerHolds,
  claimantOwner,
  describeOwner,
  ownerGone,
  ownerKind,
} from "../src/owner.ts";
import { MINUTE, fixture } from "./helpers.ts";

test("claimantOwner: flags, then SIMPOOL_ID, then the worktree", () => {
  const { worktree } = fixture();
  const dir = worktree("a");

  assert.equal(claimantOwner({}, {}, dir), dir);
  assert.equal(claimantOwner({}, { SIMPOOL_ID: "ci-7" }, dir), "id:ci-7");
  assert.equal(claimantOwner({ id: "mine" }, { SIMPOOL_ID: "ci-7" }, dir), "id:mine");
  assert.equal(claimantOwner({ worktree: dir }, { SIMPOOL_ID: "ci-7" }, "/"), dir);
  assert.equal(claimantOwner({ session: "abc" }, {}, dir), "session:abc");
  assert.match(claimantOwner({ pid: String(process.pid) }, {}, dir), new RegExp(`^pid:${process.pid}@\\d+$`));
  assert.throws(() => claimantOwner({ id: "x", session: "y" }, {}, dir), /--id and --session/);
  assert.throws(() => claimantOwner({ pid: "nope" }, {}, dir), /No running process/);
});

test("agentSession reads the nearest agent's session id", () => {
  assert.equal(agentSession({}), undefined);
  assert.equal(agentSession({ CLAUDE_CODE_SESSION_ID: "c" }), "c");
  assert.equal(agentSession({ CODEX_THREAD_ID: "x" }), "x");
  assert.equal(agentSession({ SIMPOOL_SESSION: "s", CODEX_THREAD_ID: "x" }), "s");
  // Both set (one agent started the other): the one found first walking up the tree wins.
  const both = { CLAUDE_CODE_SESSION_ID: "c", CODEX_THREAD_ID: "x" };
  assert.equal(agentSession({ ...both, CLAUDE_PID: String(process.ppid) }), "c");
  assert.equal(agentSession({ ...both, CLAUDE_PID: "999999" }), undefined);
});

test("each kind is held by the matching caller only", () => {
  const me = claimantOwner({ pid: String(process.ppid) }, {}, "/");
  const caller = { owner: "/w/a", session: "s1", id: "ci-7", ancestors: () => ancestry() };

  assert.ok(callerHolds("/w/a", caller));
  assert.ok(!callerHolds("/w/b", caller));
  assert.ok(callerHolds("session:s1", caller));
  assert.ok(!callerHolds("session:s2", caller));
  assert.ok(callerHolds("id:ci-7", caller));
  assert.ok(!callerHolds("id:ci-7", { owner: "/w/a" }));
  // Our parent process is in our ancestry, as the agent is in the hook's.
  assert.ok(callerHolds(me, caller));
  assert.ok(!callerHolds(me, { owner: "/w/a" }));
});

test("ownerGone: removed worktree and exited process; ids and sessions never", () => {
  const exited = spawnSync("true").pid as number;
  assert.equal(ownerGone("/no/such/worktree"), "worktree removed");
  assert.equal(ownerGone(`pid:${exited}@1`), `process ${exited} exited`);
  assert.equal(ownerGone(claimantOwner({ pid: String(process.pid) }, {}, "/")), undefined);
  assert.equal(ownerGone("id:anything"), undefined);
  assert.equal(ownerGone("session:anything"), undefined);
  assert.deepEqual(["/a", "pid:1@2", "session:x", "id:a:b"].map(ownerKind), ["worktree", "pid", "session", "id"]);
  assert.equal(describeOwner("pid:42@1"), "process 42");
  assert.equal(describeOwner("id:a:b"), "id a:b");
});

test("a pid lease is reclaimed as soon as its process exits", () => {
  const { pool, worktree } = fixture();
  const dead = `pid:${spawnSync("true").pid}@1`;
  const held = pool.lease("ios", { owner: dead, label: "gone" });
  pool.lease("ios", { owner: worktree("b"), label: "b" });

  const taken = pool.lease("ios", { owner: worktree("c"), label: "c" });
  assert.equal(taken.udid, held.udid);
  assert.match(taken.reclaimed?.reason ?? "", /^process \d+ exited$/);
});

test("an id lease goes stale only past the TTL", () => {
  const { pool, clock, worktree } = fixture();
  pool.lease("ios", { owner: "id:ci-7", label: "ci" });
  pool.lease("ios", { owner: worktree("b"), label: "b" });
  clock.now += 59 * MINUTE;
  pool.renew(worktree("b"));
  assert.equal(pool.status()[0]?.stale, undefined);
  clock.now += 2 * MINUTE;
  assert.match(pool.status()[0]?.stale ?? "", /^idle 61 min$/);
});

test("authorize follows the lease's session across directories", () => {
  const { pool, worktree } = fixture();
  const a = worktree("a");
  pool.lease("ios", { owner: a, label: "a", session: "s1" });

  assert.deepEqual(pool.authorize({ owner: worktree("elsewhere"), session: "s1" }, "ios-1"), { ok: true, slot: "ios-1" });
  assert.equal(pool.authorize({ owner: worktree("elsewhere"), session: "s2" }, "ios-1").ok, false);
  pool.lease("ios", { owner: "id:ci-7", label: "ci" });
  assert.equal(pool.authorize({ owner: a, id: "ci-7" }, "ios-2").ok, true);
});
