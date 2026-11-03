import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.ts";
import type { Device, Devices } from "../src/platforms/driver.ts";
import { Pool } from "../src/pool.ts";

/** A platform's devices in memory. `makeId` picks the id format (UDID, emulator serial, …). */
export class FakeDevices implements Devices {
  list: Device[] = [];
  booted: string[] = [];
  private next = 1;
  private makeId: (n: number, slot: string) => { id: string; aliases?: string[] };

  constructor(makeId?: (n: number, slot: string) => { id: string; aliases?: string[] }) {
    this.makeId = makeId ?? ((n) => ({ id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}` }));
  }

  devices(): Device[] {
    return this.list;
  }

  create(slot: string, name: string): string {
    const { id, aliases } = this.makeId(this.next++, slot);
    this.list.push({ id, name, state: "Shutdown", isAvailable: true, ...(aliases ? { aliases } : {}) });
    return id;
  }

  rename(id: string, name: string): void {
    const device = this.list.find((d) => d.id === id);
    if (device) device.name = name;
  }

  boot(id: string): void {
    this.booted.push(id);
  }

  shutdown(): void {}

  nameOf(id: string): string | undefined {
    return this.list.find((d) => d.id === id)?.name;
  }
}

/** Mimics the Android driver: slot android-N is `emulator-<5570 + 2(N-1)>`, alias its AVD name. */
export function fakeEmulators(): FakeDevices {
  return new FakeDevices((_n, slot) => {
    const index = Number(slot.split("-")[1]);
    return { id: `emulator-${5570 + 2 * (index - 1)}`, aliases: [`simpool_android_${index}`] };
  });
}

export interface Fixture {
  pool: Pool;
  /** iOS simulators. */
  sims: FakeDevices;
  /** Android emulators. */
  emus: FakeDevices;
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
    ...overrides,
    platforms: {
      ios: { size: 2, portBase: 8081 },
      android: { size: 2, portBase: 8091 },
      ...overrides.platforms,
    },
  };
  const sims = new FakeDevices();
  const emus = fakeEmulators();
  const clock = { now: 1_000_000_000_000 };
  return {
    pool: new Pool(config, { ios: sims, android: emus }, () => clock.now),
    sims,
    emus,
    clock,
    worktree(name) {
      const dir = join(root, name);
      mkdirSync(dir, { recursive: true });
      return dir;
    },
  };
}

export const MINUTE = 60_000;
