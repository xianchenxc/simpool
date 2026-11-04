# simpool

**One simulator per worktree for parallel AI coding agents.**

Run three Claude Code or Codex sessions on one Mac and they will happily
install over each other's app on the same simulator or emulator, tap each
other's screens, and fight over Metro's port 8081. simpool leases each
worktree its own iOS simulator or Android emulator and port, and a hook makes
sure agents actually stick to it.

```bash
$ simpool lease ios
🔒 ios-2 for "feat/checkout" — port 8082
0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0
```

- 📱 **iOS and Android.** iOS simulators via `simctl`, Android emulators
  (Google's official emulator, AVDs) via `adb`; each platform is a driver.
- 🔒 **Leases per worktree.** Sticky: the same worktree always gets the same
  warm device, with your app still installed.
- 🛡️ **Enforced, not just polite.** A PreToolUse hook for Claude Code and
  Codex denies device calls on a device the worktree did not lease, on
  `booted` / `adb -e`, or with no device at all.
- 🏷️ **Visible.** Leased devices are renamed `🔒 <branch> · simpool ios-2`,
  so every simulator window says which task it belongs to.
- ♻️ **Self-healing.** A lease goes stale when its worktree is deleted or it
  sits idle past the TTL. The next agent that needs a device reclaims it; live
  holders are never displaced.
- 🔌 **A port per slot.** `ios-N` gets port `8080 + N`, `android-N` gets
  `8090 + N`, for Metro or any dev server, so parallel bundlers never collide.
- 🧮 **Bounded.** A fixed pool (3 simulators, 2 emulators by default) instead
  of one new device per agent, so your RAM survives.

## Install

```bash
npm install -g simpool
simpool setup            # Claude Code + Codex: skill + PreToolUse hook
```

`setup` writes:

| | Claude Code | Codex |
|---|---|---|
| Skill | `~/.claude/skills/simpool/` | `~/.agents/skills/simpool/` |
| Hook | `~/.claude/settings.json` | `~/.codex/hooks.json` |

Codex only runs new hooks after you trust them: open Codex and approve the
simpool hook in `/hooks`. Use `simpool setup --claude` or `--codex` for one
agent, `--dry-run` to preview, and `--remove` to uninstall. Existing files are
backed up to `*.simpool-backup`.

### Enforced or cooperative

| Mode | Install | Behavior |
|---|---|---|
| **Enforced** (default) | `simpool setup` | Skill + hook. Simulator calls outside your lease are denied. |
| **Cooperative** | `simpool setup --no-hook` | Skill only. Agents lease devices because the skill tells them to; nothing stops one that doesn't. |

Cooperative mode suits agents without hook support, or when you still drive
other simulators by hand. Run `setup` again with or without `--no-hook` to
switch.

Requires macOS and Node 22.18+, plus Xcode for iOS and Android Studio (SDK
and at least one AVD) for Android.

## Usage

Agents pick this up from the skill. By hand:

```bash
SIM=$(simpool lease ios)                        # UDID only on stdout
simpool lease ios --json                        # {"slot","udid","port","label"}
xcrun simctl install "$SIM" build/MyApp.app
npx expo run:ios --device "$SIM" --port 8082

EMU=$(simpool lease android)                    # emulator serial, e.g. emulator-5570
adb -s "$EMU" install app-debug.apk
npx expo run:android --device simpool_android_1 --port 8091

simpool status                                  # who holds what
simpool challenge ios-1                         # take over a stale lease
simpool release [--shutdown]                    # done with the device
simpool gc                                      # free every stale lease now
simpool log --since 6h                          # what happened: leases, reclaims, denials, boots
simpool log --event deny,refuse -n 20 --json    # filter by kind, newest last
```

`simpool lease android --json` adds `serial` and `avd` (the AVD name Expo's
`--device` takes); for iOS it adds `udid`.

`lease` and `challenge` exit with **3** when they refuse: the pool is full of
live leases, or the device you challenged is still in use.

### Who holds a lease

A lease belongs to an identity. The worktree is the default and the one to
prefer; pass another with `lease`, `challenge`, `renew` and `release`:

| Identity | Shares the device with | Reclaimed when | The hook recognises it by |
|---|---|---|---|
| *(default)* or `--worktree <path>` | every session in that worktree | the worktree is deleted, or idle past the TTL | the git toplevel of the call's cwd |
| `--pid <pid>` | that process only | the process exits, or idle past the TTL | the pid among the hook's ancestors (`--pid "$CLAUDE_PID"` for the agent) |
| `--session <id>` | that agent session only | idle past the TTL | the session id in the hook payload |
| `--id <string>` or `SIMPOOL_ID` | everyone using that string | idle past the TTL | `SIMPOOL_ID` in the agent's environment |

The session that took a lease is recognised too (from `SIMPOOL_SESSION`,
Claude Code's `CLAUDE_CODE_SESSION_ID` or Codex's `CODEX_THREAD_ID`; when one
agent runs inside another, the nearest one in the process tree wins), so an
agent that `cd`s into another repository keeps its device. Any string is a convention, not isolation: two
agents with the same id share one device. Export `SIMPOOL_ID` before starting
the agent so the hook sees it too; an id passed only on the command line can
lease, but the hook will not let that agent drive the device.

## What the hook checks

The hook runs before `Bash` calls and simulator / emulator MCP tools in both
agents.

| Call | Result |
|---|---|
| `xcrun simctl … booted …` | denied: `booted` may be another agent's device |
| `simctl` / `xcodebuild` / `expo run:ios` with a UDID you leased | allowed, lease renewed |
| … with a UDID leased by another worktree | denied, names the holder |
| … with a simulator outside the pool | denied |
| `expo run:ios` / `react-native run-ios` without a device | denied |
| Claude's simulator MCP `control` without `device` | denied (except `detach`) |
| XcodeBuildMCP & co. with `simulatorId` / `udid` / … | checked like a UDID |
| `adb` without `-s` / `ANDROID_SERIAL`, or with `-e` / `-d` | denied (except `adb devices`, `kill-server`, …) |
| `adb -s`, `expo run:android --device`, `emulator -avd` on your emulator | allowed, lease renewed |
| … on another worktree's emulator, or one outside the pool | denied |
| `adb -s <physical device>` | allowed: not simpool's business |
| `expo run:android` / `react-native run-android` without a device | denied |
| Android MCP tools with `device` / `serial` | checked like a serial |
| Anything else | allowed, ~30 ms overhead |

If the pool itself breaks, the hook fails open rather than blocking your
shell.

## Configuration

`~/.simpool/config.json` (all optional):

```json
{
  "ttlMinutes": 60,
  "ios": { "size": 3, "deviceType": "iPhone 17", "portBase": 8081 },
  "android": { "size": 2, "deviceType": "Pixel_10", "portBase": 8091, "consolePortBase": 5570 }
}
```

Environment overrides: `SIMPOOL_HOME`, `SIMPOOL_TTL_MINUTES`, and per
platform `SIMPOOL_<PLATFORM>_SIZE` / `SIMPOOL_<PLATFORM>_DEVICE_TYPE`
(`SIMPOOL_IOS_SIZE`, `SIMPOOL_ANDROID_DEVICE_TYPE`, …).

- **iOS** `deviceType` is a simulator device type. Without one simpool picks
  the newest plain iPhone on the newest runtime that supports it.
- **Android** `deviceType` is the AVD to copy. Without one simpool copies the
  AVD with the newest API level. Slot `android-N` is its own AVD,
  `simpool_android_N`, listening on console port `consolePortBase + 2(N-1)`,
  so its serial is fixed (`emulator-5570`, `emulator-5572`, …). Ports 5554–5568
  stay free for emulators you start yourself; adb only discovers ports up to
  5584, so keep `size` at 8 or below. The SDK is found through `ANDROID_HOME`,
  `ANDROID_SDK_ROOT` or `~/Library/Android/sdk`.

## How it works

- State lives in `~/.simpool/state.json`: slots (`ios-1` → UDID,
  `android-1` → serial) and leases (slot → worktree, label, session, port,
  timestamps).
- Events go to `~/.simpool/events.jsonl`, one JSON object per line: `lease`,
  `renew`, `reclaim`, `challenge`, `refuse`, `release`, `gc`, `create`, `boot`
  (slow boots and failures, with their duration) and `deny` (every call the
  hook refused, with the command and the reason). Past 5 MB the file rolls
  over to `events.1.jsonl`. `simpool log` reads both.
- Every change runs under an atomic `mkdir` lock with stale-lock recovery, so
  simultaneous claims from parallel agents always get distinct devices.
- The owner of a lease is, by default, the git toplevel of the caller's
  working directory, so every worktree is its own tenant (see
  [Who holds a lease](#who-holds-a-lease)).
- Pool devices are created on first use (`simpool ios-N` simulators,
  `simpool_android_N` AVDs copied from the hardware profile of an existing
  one) and reused after that; simpool never touches devices outside the pool.
- Each platform is a driver in `src/platforms/` (`ios.ts`, `android.ts`): how
  to create, boot and list its devices, and which shell commands and MCP
  tools the hook checks. Adding a platform is one new driver plus one line in
  `src/platforms/index.ts`.

## Roadmap

- Claude Code / Codex plugin packaging
- Homebrew formula

## Releasing

Releases are automated with [Release Please](https://github.com/googleapis/release-please).
Every push to `main` updates a Release PR that bumps the version and the
CHANGELOG from conventional commits (`fix:` → patch, `feat:` → minor while
below 1.0). Merging it tags the release and publishes to npm from GitHub
Actions through npm Trusted Publishing, so no npm token is stored anywhere.

## License

MIT
