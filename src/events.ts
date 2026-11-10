import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { basename, join } from "node:path";

export type EventKind =
  | "lease" // a new lease
  | "renew" // `lease` again on a device already held
  | "reclaim" // a stale lease taken over by `lease`
  | "challenge" // a stale lease taken over by `challenge`
  | "refuse" // lease or challenge refused: pool full, holder live
  | "release"
  | "gc"
  | "create" // a pool device created
  | "boot" // a device booted (slow boots only), or failed to
  | "shutdown" // a pool device shut down: released, stale or idle
  | "deny"; // the hook denied a tool call

export interface PoolEvent {
  /** Epoch ms. */
  t: number;
  event: EventKind;
  slot?: string;
  platform?: string;
  device?: string;
  owner?: string;
  label?: string;
  session?: string;
  agent?: string;
  /** Label of the holder a lease was taken from. */
  from?: string;
  reason?: string;
  tool?: string;
  command?: string;
  ms?: number;
  error?: string;
}

const MAX_BYTES = 5 * 1024 * 1024;
const COMMAND_CHARS = 300;

function files(home: string): [older: string, current: string] {
  return [join(home, "events.1.jsonl"), join(home, "events.jsonl")];
}

/** Appends one event to ~/.simpool/events.jsonl, keeping one older file once it grows past 5 MB. */
export function logEvent(home: string, event: PoolEvent): void {
  try {
    const [older, current] = files(home);
    mkdirSync(home, { recursive: true });
    try {
      if (statSync(current).size > MAX_BYTES) renameSync(current, older);
    } catch {
      // No log yet.
    }
    const line = event.command ? { ...event, command: event.command.slice(0, COMMAND_CHARS) } : event;
    // One short appended line is atomic, so parallel agents never interleave.
    appendFileSync(current, `${JSON.stringify(line)}\n`);
  } catch {
    // Logging must never break a lease or a hook.
  }
}

export function readEvents(home: string): PoolEvent[] {
  const events: PoolEvent[] = [];
  for (const file of files(home)) {
    let text = "";
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      try {
        if (line) events.push(JSON.parse(line) as PoolEvent);
      } catch {
        // A torn line from a crash: skip it.
      }
    }
  }
  return events;
}

/** "90m", "6h", "2d" → milliseconds. */
export function parseSince(text: string): number {
  const match = /^(\d+)\s*(m|h|d)$/.exec(text.trim());
  if (!match) throw new Error(`Cannot read --since "${text}"; use e.g. 30m, 6h or 2d.`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return Number(match[1]) * unit;
}

export function formatEvent(e: PoolEvent): string {
  const d = new Date(e.t);
  const p = (n: number) => String(n).padStart(2, "0");
  const time = `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  const who = e.label ? `"${e.label}"` : e.owner ? basename(e.owner) : "";
  const details = [
    e.from && `from "${e.from}"`,
    e.reason,
    e.ms !== undefined && `${(e.ms / 1000).toFixed(1)} s`,
    e.error && `error: ${e.error}`,
    e.tool && e.tool !== "Bash" && e.tool,
    e.command && `$ ${e.command.replace(/\s+/g, " ")}`,
  ].filter(Boolean);
  const rest = [who, details.join(" · ")].filter(Boolean).join("  ");
  return `${time}  ${e.event.padEnd(9)} ${(e.slot ?? e.platform ?? "-").padEnd(10)} ${rest}`.trimEnd();
}
