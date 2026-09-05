/*
 * Who last wrote to a volume.
 *
 * Docker does not know. There is no field for it, and there cannot be: a volume
 * is a directory, and the daemon has no opinion about which of the twenty-five
 * checkouts on this machine put those bytes there. But it is the question that
 * matters most on a machine like this one — every worktree shares the same
 * global volumes, so the bundle your app is serving may well have been built by
 * a branch you have never checked out, and nothing anywhere says so.
 *
 * agentglass is in a good position to answer it, because it is watching
 * containers start and stop anyway. So it keeps its own ledger:
 *
 *   volume -> the last container that mounted it read-write and finished,
 *             with the checkout and branch that container came from.
 *
 * Three rules, and they are the whole design:
 *
 *   1. IT LIVES HERE. Not inside the volume, not in anybody's repository.
 *      Writing a marker file into a shared volume to answer a question about
 *      that volume is how you end up serving your own bookkeeping to a browser;
 *      writing one into a checkout is worse.
 *   2. WHAT IT DID NOT SEE, IT DOES NOT KNOW. No timestamps-on-disk heuristics,
 *      no "probably the newest worktree". An unobserved volume reads as
 *      unknown, which is both true and useful — an unknown volume is very often
 *      exactly the one you can delete.
 *   3. IT NEVER GOES BACKWARDS. Two agentglass instances watching the same
 *      daemon must not overwrite each other's newer observation with an older
 *      one, so every write merges against what is on disk by timestamp.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export interface VolumeWrite {
  /** The checkout the writing container was brought up from. */
  worktree: string;
  branch: string | null;
  /** ISO timestamp of when the write was observed to finish. */
  at: string;
  /** The container that did it — a compose service name where there is one,
   *  since `install-app-keypad` says far more than a hex id. */
  via: string;
}

export interface VolumeRecord {
  last: VolumeWrite | null;
  /** Every checkout ever seen mounting this volume, newest first, capped. This
   *  is what turns "frontend" into "shared by six worktrees". */
  seen: string[];
}

const FILE = join(
  process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"),
  "agentglass",
  "docker-owners.json",
);

let override: string | null = null;
/** Test seam, so a suite never touches the developer's own ledger. */
export function __setLedgerPath(p: string | null): void { override = p; cache = null; }
const path = (): string => override ?? FILE;

/** How many volumes are remembered. Past this the oldest observations go: a
 *  machine that has churned through thousands of one-off volumes should not
 *  carry a file that grows forever. */
const MAX_VOLUMES = 500;
/** How many distinct checkouts are remembered per volume. */
const MAX_SEEN = 24;

type Ledger = Record<string, VolumeRecord>;
let cache: Ledger | null = null;

function read(): Ledger {
  if (cache) return cache;
  try {
    const raw = JSON.parse(readFileSync(path(), "utf8")) as unknown;
    cache = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Ledger) : {};
  } catch {
    // Missing, unreadable, or written by something else: an empty ledger is the
    // honest answer and it refills itself from the next container that exits.
    cache = {};
  }
  return cache;
}

function write(next: Ledger): void {
  cache = next;
  try {
    mkdirSync(dirname(path()), { recursive: true });
    const tmp = `${path()}.tmp`;
    writeFileSync(tmp, JSON.stringify(next), "utf8");
    // Temp file + rename: a reader — including another agentglass — sees the
    // old file or the new one, never half of either.
    renameSync(tmp, path());
    try { chmodSync(path(), 0o600); } catch { /* a filesystem without modes */ }
  } catch { /* a ledger that cannot be saved still works for this session */ }
}

/** Newer wins, and "no timestamp" always loses. */
const newer = (a: VolumeWrite | null, b: VolumeWrite | null): VolumeWrite | null => {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b.at) > Date.parse(a.at) ? b : a;
};

/**
 * Record that a container finished writing to these volumes.
 *
 * Merged against the file rather than against the in-memory copy: a second
 * agentglass (a phone session, a second window, a cron) may have written since
 * this process last read, and clobbering its newer observation with an older
 * one is exactly the failure this ledger exists to avoid.
 */
export function noteWrite(volumes: string[], write_: VolumeWrite): void {
  if (!volumes.length) return;
  cache = null;                                  // re-read: somebody else may have written
  const led = { ...read() };
  for (const name of volumes) {
    const cur = led[name] ?? { last: null, seen: [] };
    const seen = [write_.worktree, ...cur.seen.filter((w) => w !== write_.worktree)].slice(0, MAX_SEEN);
    led[name] = { last: newer(cur.last, write_), seen };
  }
  write(prune(led));
}

/** Drop the least recently written volumes when the file gets long. */
function prune(led: Ledger): Ledger {
  const names = Object.keys(led);
  if (names.length <= MAX_VOLUMES) return led;
  const byAge = names.sort((a, b) => Date.parse(led[b]!.last?.at ?? "") - Date.parse(led[a]!.last?.at ?? ""));
  const keep: Ledger = {};
  for (const n of byAge.slice(0, MAX_VOLUMES)) keep[n] = led[n]!;
  return keep;
}

/** What is known about one volume, or null when nothing is. Null is a real
 *  answer here and the UI says "unknown" rather than inventing a worktree. */
export function ledgerFor(name: string): VolumeRecord | null {
  return read()[name] ?? null;
}

/** The whole ledger, for the volume list. */
export function ledgerAll(): Ledger {
  return read();
}

/** Forget a volume — called when docker says it no longer exists. A record that
 *  outlives its volume is a lie with a date on it. */
export function forget(names: string[]): void {
  if (!names.length) return;
  cache = null;
  const led = { ...read() };
  let touched = false;
  for (const n of names) if (led[n]) { delete led[n]; touched = true; }
  if (touched) write(led);
}
