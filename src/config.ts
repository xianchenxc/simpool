import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Platform = "ios";

export interface PlatformConfig {
  /** Number of devices in the pool. */
  size: number;
  /** Simulator device type name, e.g. "iPhone 17". Undefined picks the newest plain iPhone. */
  deviceType?: string;
  /** Slot N gets port portBase + N - 1 (Metro, dev servers, …). */
  portBase: number;
}

export interface Config {
  home: string;
  ttlMinutes: number;
  /** A lease younger than this is never reclaimed for a missing owner directory. */
  graceMinutes: number;
  ios: PlatformConfig;
}

interface ConfigFile {
  ttlMinutes?: number;
  graceMinutes?: number;
  ios?: Partial<PlatformConfig>;
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.SIMPOOL_HOME ?? join(homedir(), ".simpool");
  let file: ConfigFile = {};
  try {
    file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as ConfigFile;
  } catch {
    // No config file: defaults apply.
  }
  return {
    home,
    ttlMinutes: int(env.SIMPOOL_TTL_MINUTES) ?? file.ttlMinutes ?? 60,
    graceMinutes: file.graceMinutes ?? 2,
    ios: {
      size: int(env.SIMPOOL_IOS_SIZE) ?? file.ios?.size ?? 3,
      deviceType: env.SIMPOOL_IOS_DEVICE_TYPE ?? file.ios?.deviceType,
      portBase: file.ios?.portBase ?? 8081,
    },
  };
}
