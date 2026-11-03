/** A device as a driver lists it. */
export interface Device {
  /** What agents pass to tools: a UDID, an emulator serial, … */
  id: string;
  name: string;
  state: string;
  isAvailable: boolean;
  /** Other strings that name the same device, e.g. an AVD name. */
  aliases?: string[];
}

/** Everything the pool needs to manage one platform's devices; tests swap in a fake. */
export interface Devices {
  devices(): Device[];
  /** Creates the device backing `slot` (or reuses one left over) and returns its id. */
  create(slot: string, name: string): string;
  rename(id: string, name: string): void;
  /** Boots when needed and waits until the device is usable. */
  boot(id: string): void;
  shutdown(id: string): void;
}

export interface PlatformConfig {
  /** Number of devices in the pool. */
  size: number;
  /** Slot N gets port portBase + N - 1 (Metro, dev servers, …). */
  portBase: number;
  /** What to create: a simulator device type, a base AVD, … Undefined lets the driver pick. */
  deviceType?: string;
  /** Driver-specific settings. */
  [key: string]: unknown;
}

/** What the hook needs to recognise this platform's tools in a shell command. */
export interface ShellRules {
  /** Commands worth checking at all. */
  trigger: RegExp;
  /** Strings in the command that may name a device; the hook keeps the ones that do. */
  refs(command: string): string[];
  /** A deny reason for calls that are wrong whatever the device (`booted`, `adb -e`, …). */
  forbidden?(command: string): string | undefined;
  /** A deny reason when the command names no known device but needs one. */
  missingDevice?(command: string): string | undefined;
}

export interface McpRules {
  /** Words in MCP tool names that drive this platform's devices. */
  keywords: string[];
  /** Input fields holding a device id. */
  fields: string[];
  /** Tools that silently fall back to "the booted device" when no device is given. */
  needsDevice?: Record<string, (input: Record<string, unknown>) => boolean>;
}

export interface PlatformDriver {
  /** Slot prefix and `simpool lease <name>`. */
  name: string;
  defaults: PlatformConfig;
  open(config: PlatformConfig, home: string): Devices;
  shell: ShellRules;
  mcp: McpRules;
  /** Extra `--json` fields for a lease, e.g. `{ udid }`. */
  describe(id: string, aliases: string[]): Record<string, string>;
}

export function leaseHint(platform: string, what = "id"): string {
  return `Run \`simpool lease ${platform}\` and use the ${what} it prints.`;
}
