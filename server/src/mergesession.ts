/*
 * What git forgets: which files this stop conflicted.
 *
 * "3 of 5 files resolved" needs to know there were five. Git does not keep
 * that. The moment a conflicted file is staged it leaves the unmerged list —
 * measured, not assumed: `git ls-files -u | wc -l` goes from 3 to 0 across a
 * single `git add`, and afterwards the path is indistinguishable from the
 * hundreds of files the merge staged for you on its own.
 *
 * So three separate things in the conflict screen are wrong without a record
 * of the set: the counter, which resets to "0 of 2" if you reload halfway; the
 * per-file ticks, which cannot tell a file you resolved from one that never
 * conflicted; and the marker scan before committing, which would otherwise
 * have to sweep the whole index.
 *
 * The record is per STOP, not per operation. A rebase stops once per commit
 * with a different set of files each time, so the key carries the commit being
 * replayed: settling commit 1 must not leave commit 2's screen claiming three
 * files are already done.
 *
 * Deliberately not a database: this is a hint that makes a counter honest, and
 * everything it says is re-derivable from git plus the passage of time. A lost
 * file costs an inaccurate count until the next observation, not a lost
 * resolution.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

export interface MergeStop {
  /** Every file this stop conflicted, as first seen. Only grows. */
  files: string[];
  /** Of those, the ones resolved through this app — which is what makes
   *  reopening one a decision about our own work rather than somebody else's. */
  mine: string[];
  /** Last touched, for pruning. */
  at: number;
}

type Stored = Record<string, MergeStop>;

const FILE = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), ".config"),
  "agentglass",
  "merge-sessions.json",
);

let override: string | null = null;
let cache: Stored | null = null;
/** Test seam, so a suite never reads or writes the developer's own state. */
export function __setSessionPath(p: string | null): void { override = p; cache = null; }
const path = (): string => override ?? FILE;

/** A month. Long enough for a merge somebody walked away from, short enough
 *  that the file does not accumulate a year of dead worktrees. */
const KEEP_MS = 30 * 24 * 3600_000;

function load(): Stored {
  if (cache) return cache;
  try {
    cache = existsSync(path()) ? (JSON.parse(readFileSync(path(), "utf8")) as Stored) : {};
  } catch {
    // A corrupt file is not worth an error path: the whole record is a hint,
    // and starting over costs one inaccurate count.
    cache = {};
  }
  return cache!;
}

function save(s: Stored): void {
  cache = s;
  try {
    mkdirSync(dirname(path()), { recursive: true });
    writeFileSync(path(), JSON.stringify(s, null, 2) + "\n");
  } catch { /* unwritable config dir: counts go stale across a restart, nothing breaks */ }
}

const keyOf = (root: string, op: string) => `${root}\u0000${op}`;

/** Drop stops nothing has touched in a month. */
function prune(s: Stored, now: number): Stored {
  const out: Stored = {};
  for (const [k, v] of Object.entries(s)) if (now - (v.at || 0) < KEEP_MS) out[k] = v;
  return out;
}

/**
 * Record what is conflicted right now, and answer with everything known about
 * this stop.
 *
 * Union rather than replace: `unmerged` shrinks as files are resolved, and the
 * whole point is to still know what the set was. It only ever grows within a
 * stop, and a new stop gets a new key.
 */
export function observe(root: string, op: string, unmerged: string[], now = Date.now()): MergeStop {
  if (!op) return { files: [], mine: [], at: now };
  const s = load();
  const k = keyOf(root, op);
  const had = s[k] ?? { files: [], mine: [], at: now };
  const files = [...new Set([...had.files, ...unmerged])].sort();
  const next: MergeStop = { files, mine: had.mine, at: now };
  save(prune({ ...s, [k]: next }, now));
  return next;
}

/** Note that this app resolved these files — not git, not an agent in a tab. */
export function noteResolved(root: string, op: string, rels: string[], now = Date.now()): void {
  if (!op || !rels.length) return;
  const s = load();
  const k = keyOf(root, op);
  const had = s[k] ?? { files: [], mine: [], at: now };
  const next: MergeStop = {
    files: [...new Set([...had.files, ...rels])].sort(),
    mine: [...new Set([...had.mine, ...rels])].sort(),
    at: now,
  };
  save({ ...s, [k]: next });
}

/** A file went back to being conflicted, so it is no longer ours to reopen
 *  without asking again. */
export function noteReopened(root: string, op: string, rel: string, now = Date.now()): void {
  if (!op) return;
  const s = load();
  const k = keyOf(root, op);
  const had = s[k];
  if (!had) return;
  save({ ...s, [k]: { ...had, mine: had.mine.filter((f) => f !== rel), at: now } });
}

/** Read without recording — for the callers that must not create a stop. */
export function stopFor(root: string, op: string): MergeStop | null {
  if (!op) return null;
  return load()[keyOf(root, op)] ?? null;
}

/** The operation is over; the record is no longer about anything. */
export function forget(root: string, op: string): void {
  if (!op) return;
  const s = load();
  const k = keyOf(root, op);
  if (!(k in s)) return;
  const next = { ...s };
  delete next[k];
  save(next);
}
