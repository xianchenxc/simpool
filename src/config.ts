import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { PlatformConfig, PlatformDriver } from "./platforms/driver.ts";

export type Platform = string;

export interface Config {
  home: string;
  ttlMinutes: number;
  /** A lease younger than this is never reclaimed for a missing owner directory. */
  graceMinutes: number;
  /** Platform name → its settings, in driver order. */
  platforms: Record<Platform, PlatformConfig>;
}

interface ConfigFile {
  ttlMinutes?: number;
  graceMinutes?: number;
  [platform: string]: unknown;
}

function int(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function loadConfig(drivers: PlatformDriver[], env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.SIMPOOL_HOME ?? join(homedir(), ".simpool");
  let file: ConfigFile = {};
  try {
    file = JSON.parse(readFileSync(join(home, "config.json"), "utf8")) as ConfigFile;
  } catch {
    // No config file: defaults apply.
  }
  const platforms: Record<Platform, PlatformConfig> = {};
  for (const driver of drivers) {
    const fromFile = (file[driver.name] ?? {}) as Partial<PlatformConfig>;
    const prefix = `SIMPOOL_${driver.name.toUpperCase()}`;
    platforms[driver.name] = {
      ...driver.defaults,
      ...fromFile,
      size: int(env[`${prefix}_SIZE`]) ?? fromFile.size ?? driver.defaults.size,
      deviceType: env[`${prefix}_DEVICE_TYPE`] ?? fromFile.deviceType ?? driver.defaults.deviceType,
    };
  }
  return {
    home,
    ttlMinutes: int(env.SIMPOOL_TTL_MINUTES) ?? file.ttlMinutes ?? 60,
    graceMinutes: file.graceMinutes ?? 2,
    platforms,
  };
}
