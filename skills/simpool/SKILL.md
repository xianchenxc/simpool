---
name: simpool
description: Lease an iOS simulator from simpool before building, installing, launching, screenshotting or tapping anything on a simulator. Several AI agents share this Mac; simpool gives each worktree its own simulator and dev-server port so agents never overwrite each other's app. Use whenever a task needs the iOS Simulator.
---

# simpool — one simulator per worktree

This machine runs several coding agents in parallel. Never pick a simulator
yourself, never use `booted`, and never touch a device whose name starts with 🔒
unless `simpool` gave it to you. When the simpool hook is installed it rejects
simulator calls that break these rules; without it, following them is up to you.

## 1. Lease before any simulator work

Run from the worktree you are working in:

```bash
SIM=$(simpool lease ios)          # prints only the UDID on stdout
simpool lease ios --json          # {"slot":"ios-2","udid":"…","port":8082,"label":"…"}
```

- Leases are per worktree and sticky: running `lease` again returns the same
  device and renews it. Call it at the start of every verification instead of
  remembering the UDID.
- The device is booted for you and renamed `🔒 <branch> · simpool ios-N`.
- If you are on the pool limit, `lease` reclaims a stale lease automatically.

## 2. Use the UDID and port everywhere

- Simulator MCP tools: pass the UDID as `device` / `udid` / `simulatorId` on
  every call, including attach / screenshot / tap.
- Shell: `xcrun simctl install "$SIM" …`, `xcodebuild -destination "id=$SIM"`,
  `npx expo run:ios --device "$SIM" --port <port>`.
- Start Metro or any dev server on the leased `port`, never on a default port
  another agent may be using.

## 3. When refused

`lease` and `challenge` exit with code 3 when they refuse.

- **Pool full** — every device has a live holder. Stop and tell the user who
  holds what (`simpool status`). Do not take a device.
- **Someone else's device** — if the hook says another worktree holds a
  device and that holder looks gone, run `simpool challenge <slot>`. It hands
  you the device only when the holder's worktree is deleted or the lease has
  been idle past its TTL; a live holder is never displaced.
- Never run `simpool release --slot <other> --force`; that override is for
  the user.

## 4. Release when done

```bash
simpool release              # free this worktree's device
simpool release --shutdown   # …and shut it down
```

Forgetting is not fatal: leases of deleted worktrees and idle leases are
reclaimed by the next agent that needs a device.
