import { execFileSync } from "node:child_process";

export interface SimDevice {
  udid: string;
  name: string;
  state: string;
  isAvailable: boolean;
}

/** Everything the pool needs from simctl; tests swap in a fake. */
export interface Simulators {
  devices(): SimDevice[];
  create(name: string, deviceType?: string): string;
  rename(udid: string, name: string): void;
  boot(udid: string): void;
  shutdown(udid: string): void;
}

interface Runtime {
  identifier: string;
  version: string;
  platform?: string;
  isAvailable: boolean;
  supportedDeviceTypes?: { name: string; identifier: string }[];
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Prefers the highest-numbered plain iPhone ("iPhone 17" over "iPhone 17 Pro" or "iPhone Air"). */
export function pickDeviceType(names: string[]): string | undefined {
  const numbered = names
    .map((name) => ({ name, n: /^iPhone (\d+)$/.exec(name)?.[1] }))
    .filter((t): t is { name: string; n: string } => t.n !== undefined)
    .sort((a, b) => Number(b.n) - Number(a.n));
  return numbered[0]?.name ?? names.filter((name) => name.startsWith("iPhone")).at(-1);
}

export class Simctl implements Simulators {
  private run(...args: string[]): string {
    return execFileSync("xcrun", ["simctl", ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  devices(): SimDevice[] {
    const parsed = JSON.parse(this.run("list", "devices", "-j")) as {
      devices: Record<string, SimDevice[]>;
    };
    return Object.values(parsed.devices).flat();
  }

  create(name: string, deviceType?: string): string {
    const runtimes = (JSON.parse(this.run("list", "runtimes", "-j")) as { runtimes: Runtime[] }).runtimes
      .filter((r) => r.platform === "iOS" && r.isAvailable)
      .sort((a, b) => compareVersions(b.version, a.version));
    // Some runtimes (device-specific betas) support only a handful of device types.
    for (const runtime of runtimes) {
      const supported = (runtime.supportedDeviceTypes ?? []).map((t) => t.name);
      const type = deviceType ?? pickDeviceType(supported);
      if (type && supported.includes(type)) {
        return this.run("create", name, type, runtime.identifier).trim();
      }
    }
    throw new Error(
      `No installed iOS runtime supports ${deviceType ?? "an iPhone"}; install one in Xcode > Settings > Components.`,
    );
  }

  rename(udid: string, name: string): void {
    this.run("rename", udid, name);
  }

  boot(udid: string): void {
    // bootstatus -b boots when needed and waits until the device is usable.
    this.run("bootstatus", udid, "-b");
  }

  shutdown(udid: string): void {
    try {
      this.run("shutdown", udid);
    } catch {
      // Already shut down.
    }
  }
}
