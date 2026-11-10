---
name: simpool
description: Lease an iOS simulator or Android emulator from simpool before building, installing, launching, screenshotting or tapping anything on one. Several AI agents share this Mac; simpool gives each worktree its own device and dev-server port so agents never overwrite each other's app. Use whenever a task needs the iOS Simulator or an Android emulator.
---

# simpool — one device per worktree

This machine runs several coding agents in parallel. Never pick a simulator or
emulator yourself, never use `booted`, `adb -e` or `adb -d`, and never touch a
device whose name starts with 🔒 unless `simpool` gave it to you. When the
simpool hook is installed it rejects device calls that break these rules;
without it, following them is up to you.

## 1. Lease before any device work

Run from the worktree you are working in:

```bash
SIM=$(simpool lease ios)          # prints only the UDID on stdout
EMU=$(simpool lease android)      # prints only the emulator serial, e.g. emulator-5570
simpool lease ios --json          # {"slot":"ios-2","id":"…","udid":"…","port":8082,"label":"…"}
simpool lease android --json      # {"slot":"android-1","id":"emulator-5570","serial":"emulator-5570","avd":"simpool_android_1","port":8091,…}
```

- Leases are per worktree and sticky: running `lease` again returns the same
  device and renews it. Call it at the start of every verification instead of
  remembering the id.
- Keep the default worktree identity unless the user asks for another
  (`--pid`, `--session`, `--id`); pass the same identity to `renew` and
  `release`.
- The device is booted for you (an Android emulator can take a minute on its
  first boot) and labelled `🔒 <branch> · simpool <slot>`.
- If you are on the pool limit, `lease` reclaims a stale lease automatically.
- In a sandbox (e.g. Codex), `simpool` fails with a permission error such as
  `EPERM … ~/.simpool/lock`: it must write the shared pool state and talk to
  the simulator service. Ask to run the `simpool` command outside the sandbox.
- Never change `SIMPOOL_HOME` or point simpool at another state directory to
  get around an error: that creates a separate pool other agents cannot see.

## 2. Use the id and port everywhere

iOS:

- Simulator MCP tools: pass the UDID as `device` / `udid` / `simulatorId` on
  every call, including attach / screenshot / tap.
- Shell: `xcrun simctl install "$SIM" …`, `xcodebuild -destination "id=$SIM"`,
  `npx expo run:ios --device "$SIM" --port <port>`.

Android:

- Every `adb` call takes `-s "$EMU"` (or `ANDROID_SERIAL="$EMU"`).
- Expo: `npx expo run:android --device <avd> --port <port>` with the `avd`
  from `--json`; React Native CLI: `run-android --deviceId "$EMU"`.
- A dev server started by hand needs `adb -s "$EMU" reverse tcp:<port> tcp:<port>`.
- Android MCP tools: pass the serial as `device` / `serial`.

Start Metro or any dev server on the leased `port`, never on a default port
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

When your simulator or emulator work is finished, and always before you
report the task as done, release your devices:

```bash
simpool release                # free this worktree's devices and shut them down
simpool release --keep-booted  # free them but leave them running (the user asked to keep it open)
```

A running simulator or emulator costs the user several GB of memory, so do
not skip this. simpool also frees leases idle past the TTL and shuts down
devices nobody holds, but that only happens the next time any agent runs
`simpool lease` or `simpool status`.
