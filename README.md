# simpool

**One simulator per worktree for parallel AI coding agents.**

Run three Claude Code or Codex sessions on one Mac and they will happily
install over each other's app on the same simulator, tap each other's screens,
and fight over Metro's port 8081. simpool leases each worktree its own
simulator and port, and a hook makes sure agents actually stick to it.

```bash
$ simpool lease ios
🔒 ios-2 for "feat/checkout" — port 8082
0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0
```

- 🔒 **Leases per worktree.** Sticky: the same worktree always gets the same
  warm device, with your app still installed.
- 🛡️ **Enforced, not just polite.** A PreToolUse hook for Claude Code and
  Codex denies simulator calls on a device the worktree did not lease, on
  `booted`, or with no device at all.
- 🏷️ **Visible.** Leased devices are renamed `🔒 <branch> · simpool ios-2`,
  so every simulator window says which task it belongs to.
- ♻️ **Self-healing.** A lease goes stale when its worktree is deleted or it
  sits idle past the TTL. The next agent that needs a device reclaims it; live
  holders are never displaced.
- 🔌 **A port per slot.** Slot N gets port `8080 + N` for Metro or any dev
  server, so parallel bundlers never collide.
- 🧮 **Bounded.** A fixed pool (3 by default) instead of one new simulator per
  agent, so your RAM survives.

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

Requires macOS with Xcode and Node 22.18+.

## Usage

Agents pick this up from the skill. By hand:

```bash
SIM=$(simpool lease ios)                        # UDID only on stdout
simpool lease ios --json                        # {"slot","udid","port","label"}
xcrun simctl install "$SIM" build/MyApp.app
npx expo run:ios --device "$SIM" --port 8082

simpool status                                  # who holds what
simpool challenge ios-1                         # take over a stale lease
simpool release [--shutdown]                    # done with the device
simpool gc                                      # free every stale lease now
```

`lease` and `challenge` exit with **3** when they refuse: the pool is full of
live leases, or the device you challenged is still in use.

## What the hook checks

The hook runs before `Bash` calls and simulator MCP tools in both agents.

| Call | Result |
|---|---|
| `xcrun simctl … booted …` | denied: `booted` may be another agent's device |
| `simctl` / `xcodebuild` / `expo run:ios` with a UDID you leased | allowed, lease renewed |
| … with a UDID leased by another worktree | denied, names the holder |
| … with a simulator outside the pool | denied |
| `expo run:ios` / `react-native run-ios` without a device | denied |
| Claude's simulator MCP `control` without `device` | denied (except `detach`) |
| XcodeBuildMCP & co. with `simulatorId` / `udid` / … | checked like a UDID |
| Anything else | allowed, ~30 ms overhead |

If the pool itself breaks, the hook fails open rather than blocking your
shell.

## Configuration

`~/.simpool/config.json` (all optional):

```json
{
  "ttlMinutes": 60,
  "ios": { "size": 3, "deviceType": "iPhone 17", "portBase": 8081 }
}
```

Environment overrides: `SIMPOOL_HOME`, `SIMPOOL_TTL_MINUTES`,
`SIMPOOL_IOS_SIZE`, `SIMPOOL_IOS_DEVICE_TYPE`. Without a device type simpool
picks the newest plain iPhone on the newest runtime that supports it.

## How it works

- State lives in `~/.simpool/state.json`: slots (`ios-1` → UDID) and leases
  (slot → worktree, label, session, port, timestamps).
- Every change runs under an atomic `mkdir` lock with stale-lock recovery, so
  simultaneous claims from parallel agents always get distinct devices.
- The owner of a lease is the git toplevel of the caller's working directory,
  so every worktree is its own tenant.
- Pool devices are created on first use as `simpool ios-N` and reused after
  that; simpool never touches simulators outside the pool.

## Roadmap

- Android emulators (AVD pool, fixed console ports, `adb -s` enforcement)
- Claude Code / Codex plugin packaging
- Homebrew formula

## License

MIT
