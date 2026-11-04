import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Device, type Devices, type PlatformConfig, type PlatformDriver, leaseHint } from "./driver.ts";

/** adb discovers emulators whose adb port (console port + 1) is at most this. */
const ADB_MAX_PORT = 5585;
const BOOT_TIMEOUT_MS = 300_000;

export interface Avd {
  name: string;
  dir: string;
  target?: string;
  /** API level, from the target or the system image path ("android-36.1" → 36.1). */
  api?: number;
  displayName?: string;
  /** Its system image is installed. */
  isAvailable: boolean;
}

export function parseIni(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) values[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  return values;
}

/** Replaces or appends `key=value` lines, keeping everything else as it is. */
export function setIniKeys(text: string, values: Record<string, string>): string {
  const lines = text.split("\n").filter((line, i, all) => line !== "" || i < all.length - 1);
  for (const [key, value] of Object.entries(values)) {
    const index = lines.findIndex((line) => line.split("=")[0]?.trim() === key);
    if (index >= 0) lines[index] = `${key}=${value}`;
    else lines.push(`${key}=${value}`);
  }
  return `${lines.join("\n")}\n`;
}

/** "android-2" → "simpool_android_2"; AVD names allow only [A-Za-z0-9._-]. */
export function avdName(slot: string): string {
  return `simpool_${slot.replace(/-/g, "_")}`;
}

function slotOfAvd(name: string): string | undefined {
  const match = /^simpool_(.+)_(\d+)$/.exec(name);
  return match ? `${match[1]}-${match[2]}` : undefined;
}

/** Slot N listens on consolePortBase + 2(N - 1); its adb serial is `emulator-<port>`. */
export function consolePort(base: number, slot: string): number {
  return base + 2 * (Number(slot.slice(slot.lastIndexOf("-") + 1)) - 1);
}

/** The AVD to clone: the configured one, else the newest API level that is not simpool's own. */
export function pickBaseAvd(avds: Avd[], name?: string): Avd | undefined {
  if (name) return avds.find((a) => a.name === name);
  return avds
    .filter((a) => a.isAvailable && !slotOfAvd(a.name))
    .sort((a, b) => (b.api ?? 0) - (a.api ?? 0) || a.name.localeCompare(b.name))[0];
}

/** `adb devices` output → serial → state ("device", "offline", …). */
export function parseAdbDevices(output: string): Map<string, string> {
  const devices = new Map<string, string>();
  for (const line of output.split("\n").slice(1)) {
    const [serial, state] = line.trim().split(/\s+/);
    if (serial && state) devices.set(serial, state);
  }
  return devices;
}

function stateOf(adbState: string | undefined): string {
  if (adbState === undefined) return "Shutdown";
  if (adbState === "device") return "Booted";
  if (adbState === "offline") return "Booting";
  return adbState;
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class Emulators implements Devices {
  private config: PlatformConfig;
  private home: string;
  private sdk: string;
  private avdHome: string;

  constructor(config: PlatformConfig, home: string, env: NodeJS.ProcessEnv = process.env) {
    this.config = config;
    this.home = home;
    this.sdk = env.ANDROID_HOME ?? env.ANDROID_SDK_ROOT ?? join(homedir(), "Library", "Android", "sdk");
    this.avdHome = env.ANDROID_AVD_HOME ?? join(env.ANDROID_USER_HOME ?? join(homedir(), ".android"), "avd");
  }

  private tool(dir: string, name: string): string {
    const path = join(this.sdk, dir, name);
    return existsSync(path) ? path : name;
  }

  private adb(...args: string[]): string {
    return execFileSync(this.tool("platform-tools", "adb"), args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 15_000,
    });
  }

  private port(slot: string): number {
    return consolePort(Number(this.config.consolePortBase ?? 5570), slot);
  }

  private slotOfSerial(serial: string): string | undefined {
    const port = Number(/^emulator-(\d+)$/.exec(serial)?.[1]);
    const base = Number(this.config.consolePortBase ?? 5570);
    if (!Number.isInteger(port) || port < base || (port - base) % 2 !== 0) return undefined;
    return `android-${(port - base) / 2 + 1}`;
  }

  avds(): Avd[] {
    let files: string[] = [];
    try {
      files = readdirSync(this.avdHome).filter((f) => f.endsWith(".ini"));
    } catch {
      return [];
    }
    return files.map((file) => {
      const name = file.slice(0, -".ini".length);
      const pointer = parseIni(readFileSync(join(this.avdHome, file), "utf8"));
      const dir = pointer.path && existsSync(pointer.path) ? pointer.path : join(this.avdHome, `${name}.avd`);
      let config: Record<string, string> = {};
      try {
        config = parseIni(readFileSync(join(dir, "config.ini"), "utf8"));
      } catch {
        // A dangling pointer: listed, but not usable.
      }
      const sysdir = config["image.sysdir.1"];
      const api = /android-(\d+(?:\.\d+)?)/.exec(pointer.target ?? sysdir ?? "")?.[1];
      return {
        name,
        dir,
        target: pointer.target ?? config.target,
        api: api ? Number(api) : undefined,
        displayName: config["avd.ini.displayname"],
        isAvailable: sysdir !== undefined && existsSync(join(this.sdk, sysdir)),
      };
    });
  }

  private running(): Map<string, string> {
    try {
      return parseAdbDevices(this.adb("devices"));
    } catch {
      return new Map();
    }
  }

  devices(): Device[] {
    const running = this.running();
    const devices: Device[] = [];
    for (const avd of this.avds()) {
      const slot = slotOfAvd(avd.name);
      const name = avd.displayName ?? avd.name;
      if (slot) {
        const serial = `emulator-${this.port(slot)}`;
        devices.push({ id: serial, name, state: stateOf(running.get(serial)), isAvailable: avd.isAvailable, aliases: [avd.name] });
        running.delete(serial);
      } else {
        devices.push({ id: avd.name, name, state: "Unknown", isAvailable: avd.isAvailable });
      }
    }
    // Emulators running outside the pool; physical devices are not simpool's business.
    for (const [serial, state] of running) {
      if (serial.startsWith("emulator-")) devices.push({ id: serial, name: serial, state: stateOf(state), isAvailable: true });
    }
    return devices;
  }

  create(slot: string, name: string): string {
    const port = this.port(slot);
    if (port + 1 > ADB_MAX_PORT) {
      throw new Error(`${slot} would listen on port ${port}, beyond what adb discovers (${ADB_MAX_PORT}); lower android.size or android.consolePortBase.`);
    }
    const avd = avdName(slot);
    const dir = join(this.avdHome, `${avd}.avd`);
    if (!existsSync(join(dir, "config.ini"))) {
      const avds = this.avds();
      const base = pickBaseAvd(avds, this.config.deviceType);
      if (!base) {
        const known = avds.map((a) => a.name).join(", ") || "none";
        throw new Error(
          this.config.deviceType
            ? `No AVD named "${this.config.deviceType}" (found: ${known}).`
            : "No Android Virtual Device to copy; create one in Android Studio > Device Manager.",
        );
      }
      // Copy the hardware profile only: the emulator builds fresh userdata from the system image.
      const config = readFileSync(join(base.dir, "config.ini"), "utf8");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "config.ini"), setIniKeys(config, { AvdId: avd, "avd.ini.displayname": name }));
      const pointer = { "avd.ini.encoding": "UTF-8", path: dir, "path.rel": `avd/${avd}.avd`, target: base.target ?? "" };
      writeFileSync(join(this.avdHome, `${avd}.ini`), setIniKeys("", pointer));
    }
    return `emulator-${port}`;
  }

  rename(serial: string, name: string): void {
    const slot = this.slotOfSerial(serial);
    if (!slot) return;
    const file = join(this.avdHome, `${avdName(slot)}.avd`, "config.ini");
    writeFileSync(file, setIniKeys(readFileSync(file, "utf8"), { "avd.ini.displayname": name }));
  }

  boot(serial: string): void {
    const slot = this.slotOfSerial(serial);
    if (!slot) throw new Error(`${serial} is not a simpool emulator.`);
    let pid: number | undefined;
    const log = join(this.home, `${slot}.log`);
    if (!this.running().has(serial)) {
      mkdirSync(this.home, { recursive: true });
      const out = openSync(log, "a");
      const args = ["-avd", avdName(slot), "-port", String(this.port(slot)), "-no-boot-anim"];
      const child = spawn(this.tool("emulator", "emulator"), args, { detached: true, stdio: ["ignore", out, out] });
      child.unref();
      pid = child.pid;
    }
    const deadline = Date.now() + BOOT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      try {
        if (this.adb("-s", serial, "shell", "getprop", "sys.boot_completed").trim() === "1") return;
      } catch {
        // Not reachable yet.
      }
      if (pid !== undefined && !alive(pid)) throw new Error(`The emulator for ${slot} exited; see ${log}.`);
      sleep(1000);
    }
    throw new Error(`${serial} did not finish booting in ${BOOT_TIMEOUT_MS / 60_000} min; see ${log}.`);
  }

  shutdown(serial: string): void {
    try {
      this.adb("-s", serial, "emu", "kill");
    } catch {
      // Already shut down.
    }
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** adb options that take a value; -e / -d pick "the" emulator or device. */
const ADB_VALUE_OPTIONS = new Set(["-s", "-t", "-H", "-P", "-L"]);
const ADB_NO_DEVICE = new Set(["devices", "start-server", "kill-server", "version", "help", "connect", "disconnect", "pair", "mdns", "keygen"]);

interface AdbCall {
  serial?: string;
  /** -e or -d */
  pick?: string;
  transport?: string;
  subcommand?: string;
}

/** Every `adb …` invocation in a shell command, with its global options. */
export function adbCalls(command: string): AdbCall[] {
  const calls: AdbCall[] = [];
  for (const segment of command.split(/[;&|\n]+|\$\(|`/)) {
    const tokens = segment.trim().split(/\s+/).map((t) => t.replace(/^["']|["']$/g, ""));
    const start = tokens.findIndex((t) => t === "adb" || t.endsWith("/adb"));
    if (start < 0) continue;
    const call: AdbCall = {};
    for (let i = start + 1; i < tokens.length; i++) {
      const token = tokens[i] as string;
      if (ADB_VALUE_OPTIONS.has(token)) {
        if (token === "-s") call.serial = tokens[i + 1];
        if (token === "-t") call.transport = tokens[i + 1];
        i++;
      } else if (token === "-e" || token === "-d") {
        call.pick = token;
      } else if (token.startsWith("-")) {
        // Other global flags (-a, …).
      } else {
        call.subcommand = token;
        break;
      }
    }
    calls.push(call);
  }
  return calls;
}

const RUN_ANDROID = /\brun:android\b|\brun-android\b/;
const REF_AFTER = /(?:-avd|--device|--deviceId|-s)\s+["']?([^\s"';&|)]+)|ANDROID_SERIAL=["']?([^\s"';&|)]+)/g;
const HINT = leaseHint("android", "serial");

export const android: PlatformDriver = {
  name: "android",
  // Console ports 5554–5568 stay free for emulators started by hand.
  defaults: { size: 2, portBase: 8091, consolePortBase: 5570 },
  open: (config, home) => new Emulators(config, home),
  shell: {
    trigger: /\badb\b|(?:^|[\s/])emulator\s+-|\brun:android\b|\brun-android\b/,
    refs(command) {
      const refs: string[] = [...(command.match(/\bemulator-\d+\b|\bsimpool_android_\d+\b/g) ?? [])];
      for (const match of command.matchAll(REF_AFTER)) refs.push((match[1] ?? match[2]) as string);
      return refs;
    },
    forbidden(command) {
      const pick = adbCalls(command).find((c) => c.pick)?.pick;
      return pick ? `\`adb ${pick}\` can pick another agent's emulator. Use \`adb -s <serial>\`. ${HINT}` : undefined;
    },
    missingDevice(command) {
      if (RUN_ANDROID.test(command) && !/--device(Id)?\b/.test(command)) {
        return `Pass your emulator explicitly, e.g. \`expo run:android --device <avd>\`. ${HINT}`;
      }
      if (/\bANDROID_SERIAL=/.test(command)) return undefined;
      const untargeted = adbCalls(command).find(
        (c) => !c.serial && !c.transport && !(c.subcommand && ADB_NO_DEVICE.has(c.subcommand)),
      );
      return untargeted ? `Target your emulator with \`adb -s <serial>\`. ${HINT}` : undefined;
    },
  },
  mcp: {
    keywords: ["android", "adb", "emulator", "mobile"],
    fields: ["serial", "deviceSerial", "device", "deviceId", "udid"],
  },
  describe: (id, aliases) => ({ serial: id, ...(aliases[0] ? { avd: aliases[0] } : {}) }),
};
