import type { Config, Platform } from "./config.ts";
import { type Caller, callerHolds, describeOwner, ownerGone, ownerKind } from "./owner.ts";
import type { Device, Devices } from "./platforms/driver.ts";
import { type Lease, type Slot, type State, readState, withState } from "./state.ts";

export const EXIT_REFUSED = 3;

export class SimpoolError extends Error {
  exitCode: number;
  constructor(message: string, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

export interface Claimant {
  owner: string;
  label: string;
  agent?: string;
  session?: string;
}

export interface Holding {
  slot: string;
  id: string;
  aliases: string[];
  port: number;
  lease: Lease;
  /** Set when this claim reclaimed a stale lease. */
  reclaimed?: { lease: Lease; reason: string };
}

export interface SlotStatus {
  slot: string;
  id?: string;
  deviceState?: string;
  lease?: Lease;
  stale?: string;
}

export type Authorization = { ok: true; slot: string } | { ok: false; reason: string };

const MINUTE = 60_000;

export function idleName(slot: string): string {
  return `simpool ${slot}`;
}

export function leasedName(slot: string, label: string): string {
  return `🔒 ${label} · simpool ${slot}`;
}

export function describeLease(slot: string, lease: Lease, now: number): string {
  const idle = Math.floor((now - lease.renewedAt) / MINUTE);
  const who = [lease.agent, lease.session && `session ${lease.session}`].filter(Boolean).join(", ");
  return `${slot} held by "${lease.label}" at ${describeOwner(lease.owner)}${who ? ` (${who})` : ""}, idle ${idle} min`;
}

export class Pool {
  private config: Config;
  private backends: Record<Platform, Devices>;
  private now: () => number;

  /** `backends` maps each configured platform to the driver that manages its devices. */
  constructor(config: Config, backends: Record<Platform, Devices>, now: () => number = Date.now) {
    this.config = config;
    this.backends = backends;
    this.now = now;
  }

  platforms(): Platform[] {
    return Object.keys(this.config.platforms).filter((platform) => this.backends[platform]);
  }

  slotIds(platform: Platform): string[] {
    const size = this.config.platforms[platform]?.size ?? 0;
    return Array.from({ length: size }, (_, i) => `${platform}-${i + 1}`);
  }

  private platformOf(slot: string): Platform {
    return slot.slice(0, slot.lastIndexOf("-"));
  }

  private devicesOf(slot: string): Devices {
    const backend = this.backends[this.platformOf(slot)];
    if (!backend) throw new SimpoolError(`Unknown slot "${slot}".`);
    return backend;
  }

  private port(slot: string): number {
    const index = Number(slot.slice(slot.lastIndexOf("-") + 1));
    return (this.config.platforms[this.platformOf(slot)]?.portBase ?? 0) + index - 1;
  }

  /** Why a lease may be taken over, or undefined while it is live. */
  staleReason(lease: Lease): string | undefined {
    const now = this.now();
    // A worktree may not exist yet right after the lease (created by the same script).
    const settled = ownerKind(lease.owner) !== "worktree" || now - lease.leasedAt > this.config.graceMinutes * MINUTE;
    const gone = settled ? ownerGone(lease.owner) : undefined;
    if (gone) return gone;
    const idle = now - lease.renewedAt;
    if (idle > this.config.ttlMinutes * MINUTE) return `idle ${Math.floor(idle / MINUTE)} min`;
    return undefined;
  }

  private heldBy(state: State, owner: string, platform: Platform): string | undefined {
    return this.slotIds(platform).find((slot) => state.leases[slot]?.owner === owner);
  }

  private tryRename(slot: string, id: string, name: string): void {
    try {
      this.devicesOf(slot).rename(id, name);
    } catch {
      // Cosmetic only: the window title lags behind, the lease is still correct.
    }
  }

  private ensureSlot(state: State, slot: string): Slot {
    const backend = this.devicesOf(slot);
    const existing = state.slots[slot];
    const device = existing && backend.devices().find((d) => d.id === existing.id && d.isAvailable);
    if (existing && device) {
      existing.aliases = device.aliases;
      return existing;
    }
    const id = backend.create(slot, idleName(slot));
    const aliases = backend.devices().find((d) => d.id === id)?.aliases;
    const created: Slot = { platform: this.platformOf(slot), id, ...(aliases?.length ? { aliases } : {}) };
    state.slots[slot] = created;
    return created;
  }

  private vacate(state: State, slot: string): void {
    delete state.leases[slot];
    const id = state.slots[slot]?.id;
    if (id) this.tryRename(slot, id, idleName(slot));
  }

  private assign(state: State, slot: string, claimant: Claimant): Holding {
    const { id } = this.ensureSlot(state, slot);
    const now = this.now();
    const lease: Lease = { ...claimant, port: this.port(slot), leasedAt: now, renewedAt: now };
    state.leases[slot] = lease;
    this.tryRename(slot, id, leasedName(slot, claimant.label));
    return this.holding(state, slot);
  }

  private holding(state: State, slot: string): Holding {
    const lease = state.leases[slot] as Lease;
    const { id, aliases = [] } = state.slots[slot] as Slot;
    return { slot, id, aliases, port: lease.port, lease };
  }

  /** Returns this owner's device for the platform, assigning (and booting) one if needed. */
  lease(platform: Platform, claimant: Claimant, options: { boot?: boolean } = {}): Holding {
    if (!this.platforms().includes(platform)) {
      throw new SimpoolError(`Unknown platform "${platform}". Supported: ${this.platforms().join(", ")}.`);
    }
    const holding = withState(this.config.home, (state) => {
      const mine = this.heldBy(state, claimant.owner, platform);
      if (mine) {
        const lease = state.leases[mine] as Lease;
        lease.renewedAt = this.now();
        lease.session = claimant.session ?? lease.session;
        return this.holding(state, mine);
      }
      const slots = this.slotIds(platform);
      const free = slots.find((slot) => !state.leases[slot]);
      if (free) return this.assign(state, free, claimant);

      for (const slot of slots) {
        const previous = state.leases[slot] as Lease;
        const reason = this.staleReason(previous);
        if (reason) {
          this.vacate(state, slot);
          return { ...this.assign(state, slot, claimant), reclaimed: { lease: previous, reason } };
        }
      }
      const now = this.now();
      const holders = slots.map((slot) => `  ${describeLease(slot, state.leases[slot] as Lease, now)}`);
      throw new SimpoolError(
        `All ${slots.length} ${platform} devices are held by live leases:\n${holders.join("\n")}`,
        EXIT_REFUSED,
      );
    });
    if (options.boot !== false) this.devicesOf(holding.slot).boot(holding.id);
    return holding;
  }

  /** Takes over a stale lease. A live holder is never displaced. */
  challenge(slot: string, claimant: Claimant, options: { boot?: boolean } = {}): Holding {
    const holding = withState(this.config.home, (state) => {
      const previous = state.leases[slot];
      if (!previous) {
        throw new SimpoolError(`${slot} is not leased; run \`simpool lease ${this.platformOf(slot)}\`.`);
      }
      if (previous.owner === claimant.owner) return this.holding(state, slot);
      const reason = this.staleReason(previous);
      if (!reason) {
        throw new SimpoolError(`Refused: ${describeLease(slot, previous, this.now())} is live.`, EXIT_REFUSED);
      }
      const mine = this.heldBy(state, claimant.owner, this.platformOf(slot));
      if (mine) this.vacate(state, mine);
      this.vacate(state, slot);
      return { ...this.assign(state, slot, claimant), reclaimed: { lease: previous, reason } };
    });
    if (options.boot !== false) this.devicesOf(holding.slot).boot(holding.id);
    return holding;
  }

  renew(owner: string): string[] {
    return withState(this.config.home, (state) => {
      const renewed = Object.entries(state.leases).filter(([, lease]) => lease.owner === owner);
      for (const [, lease] of renewed) lease.renewedAt = this.now();
      return renewed.map(([slot]) => slot);
    });
  }

  /** Releases the owner's leases, or one slot. Another owner's slot needs force. */
  release(owner: string, options: { slot?: string; force?: boolean; shutdown?: boolean } = {}): string[] {
    const released = withState(this.config.home, (state) => {
      let slots: string[];
      if (options.slot) {
        const lease = state.leases[options.slot];
        if (!lease) return [];
        if (lease.owner !== owner && !options.force) {
          throw new SimpoolError(
            `${describeLease(options.slot, lease, this.now())}. Use \`simpool challenge ${options.slot}\`, or --force if you are the human in charge.`,
            EXIT_REFUSED,
          );
        }
        slots = [options.slot];
      } else {
        slots = Object.keys(state.leases).filter((slot) => state.leases[slot]?.owner === owner);
      }
      for (const slot of slots) this.vacate(state, slot);
      return slots.map((slot) => ({ slot, id: state.slots[slot]?.id }));
    });
    if (options.shutdown) {
      for (const { slot, id } of released) if (id) this.devicesOf(slot).shutdown(id);
    }
    return released.map(({ slot }) => slot);
  }

  /** Frees every stale lease. */
  gc(): { slot: string; lease: Lease; reason: string }[] {
    return withState(this.config.home, (state) => {
      const reaped: { slot: string; lease: Lease; reason: string }[] = [];
      for (const [slot, lease] of Object.entries(state.leases)) {
        const reason = this.staleReason(lease);
        if (reason) {
          this.vacate(state, slot);
          reaped.push({ slot, lease, reason });
        }
      }
      return reaped;
    });
  }

  status(): SlotStatus[] {
    const state = readState(this.config.home);
    return this.platforms().flatMap((platform) => {
      let devices: Device[] = [];
      try {
        devices = (this.backends[platform] as Devices).devices();
      } catch {
        // Platform tools unavailable: still show leases.
      }
      return this.slotIds(platform).map((slot) => {
        const id = state.slots[slot]?.id;
        const lease = state.leases[slot];
        return {
          slot,
          id,
          deviceState: devices.find((d) => d.id === id)?.state,
          lease,
          stale: lease && this.staleReason(lease),
        };
      });
    });
  }

  /**
   * Whether `caller` may drive `target` (slot id, device id, alias or name). Renews the
   * lease on success, so every simulator call doubles as a heartbeat. The session that
   * holds a lease keeps it even after `cd`-ing elsewhere.
   */
  authorize(caller: Caller, target: string, platform?: Platform): Authorization {
    return withState(this.config.home, (state) => {
      const slot = Object.keys(state.slots).find((id) => {
        const device = state.slots[id];
        const lease = state.leases[id];
        return (
          target === id ||
          target === device?.id ||
          (device?.aliases ?? []).includes(target) ||
          target === idleName(id) ||
          (lease !== undefined && target === leasedName(id, lease.label))
        );
      });
      const leaseCmd = `simpool lease ${slot ? this.platformOf(slot) : (platform ?? "<platform>")}`;
      if (!slot) {
        return { ok: false, reason: `${target} is not a simpool device. Run \`${leaseCmd}\` and use the id it prints.` };
      }
      const lease = state.leases[slot];
      if (!lease) {
        return { ok: false, reason: `${slot} is not leased to you. Run \`${leaseCmd}\` and use the id it prints.` };
      }
      const sameSession = lease.session !== undefined && lease.session === caller.session;
      if (!sameSession && !callerHolds(lease.owner, caller)) {
        return {
          ok: false,
          reason: `${describeLease(slot, lease, this.now())}. Use your own device (\`${leaseCmd}\`); if that holder is gone, run \`simpool challenge ${slot}\`.`,
        };
      }
      lease.renewedAt = this.now();
      lease.session = caller.session ?? lease.session;
      return { ok: true, slot };
    });
  }

  /** Ids and aliases of every device of `platform` on this machine, for spotting device references in shell commands. */
  knownIds(platform: Platform): Set<string> {
    const names = (d: { id: string; aliases?: string[] }) => [d.id, ...(d.aliases ?? [])];
    const backend = this.backends[platform];
    try {
      if (backend) return new Set(backend.devices().flatMap(names));
    } catch {
      // Fall back to the pool's own devices.
    }
    const slots = Object.values(readState(this.config.home).slots).filter((s) => s.platform === platform);
    return new Set(slots.flatMap(names));
  }
}
