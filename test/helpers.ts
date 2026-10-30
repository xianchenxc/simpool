import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import { Pool } from "../src/pool.ts";
import type { SimDevice, Simulators } from "../src/simctl.ts";

export class FakeSims implements Simulators {
  list: SimDevice[] = [];
  booted: string[] = [];
  private next = 1;

  devices(): SimDevice[] {
    return this.list;
  }

  create(name: string): string {
    const udid = `00000000-0000-0000-0000-${String(this.next++).padStart(12, "0")}`;
    this.list.push({ udid, name, state: "Shutdown", isAvailable: true });
    return udid;
  }

  rename(udid: string, name: string): void {
    const device = this.list.find((d) => d.udid === udid);
    if (device) device.name = name;
  }

  boot(udid: string): void {
    this.booted.push(udid);
  }

  shutdown(): void {}

  nameOf(udid: string): string | undefined {
    return this.list.find((d) => d.udid === udid)?.name;
  }
}

export interface Fixture {
  pool: Pool;
  sims: FakeSims;
  clock: { now: number };
  /** Creates a fresh directory standing in for a worktree. */
  worktree(name: string): string;
}

export function fixture(overrides: Partial<Config> = {}): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "simpool-test-")));
  const config: Config = {
    home: join(root, "home"),
    ttlMinutes: 60,
    graceMinutes: 2,
    ios: { size: 2, portBase: 8081 },
    ...overrides,
  };
  const sims = new FakeSims();
  const clock = { now: 1_000_000_000_000 };
  return {
    pool: new Pool(config, sims, () => clock.now),
    sims,
    clock,
    worktree(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

export const MINUTE = 60_000;
