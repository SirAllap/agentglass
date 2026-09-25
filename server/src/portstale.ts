// Which listening ports look forgotten.
//
// A port and a pid say what is listening; none of it says whether anyone still
// wants it. Four cheap facts do most of that work — where it is serving from,
// whether that place is a scratch directory, whether a twin is serving the same
// place, and whether anything has connected for hours. All four are warnings:
// a panel that killed on a guess would eventually kill a server somebody was
// using, so nothing here ever signals a process.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * The directory a static file server is serving, when its command line says.
 *
 * `python -m http.server 8000 --directory /tmp/report` runs with the cwd of
 * whatever shell launched it — usually a checkout — and serves somewhere else
 * entirely. Labelled by cwd, the row names the wrong folder and every fact
 * derived from it (duplicates, leftovers) is about the wrong place, so the
 * served directory wins whenever it can be read.
 *
 * ONLY `http.server` is understood. `serve`, `http-server` and `vite preview`
 * take the directory positionally or from a config file, each differently; the
 * next one to be added is a case here with its own fixture, not a guess.
 * A relative path resolves against the cwd; with no cwd it is unknown, not "/".
 */
export function servedDirOf(argv: readonly string[], cwd: string | null): string | null {
  const at = argv.findIndex((a, i) => a === "http.server" && argv[i - 1] === "-m");
  if (at < 0) return null;
  let dir: string | null = null;
  for (let i = at + 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-d" || a === "--directory") { dir = argv[i + 1] ?? null; break; }
    if (a.startsWith("--directory=")) { dir = a.slice("--directory=".length); break; }
  }
  if (!dir) return null;
  if (dir.startsWith("/")) return resolve(dir);
  return cwd ? resolve(cwd, dir) : null;
}

/** The folder a row is named after: what it serves, else where it was started. */
export function folderOf(argv: readonly string[], cwd: string | null): string | null {
  return servedDirOf(argv, cwd) ?? cwd;
}

/** Under a scratch directory — where a throwaway server's files were put and
 *  where nobody looks again. `/var/tmp` counts; the OS temp dir counts too. */
export function underTmp(path: string | null): boolean {
  if (!path) return false;
  const roots = new Set(["/tmp", "/var/tmp", tmpdir()]);
  for (const r of roots) if (path === r || path.startsWith(r.endsWith("/") ? r : r + "/")) return true;
  return false;
}

interface Twinnable { mine: boolean; pid: number | null; proc: string | null; dir: string | null }

/**
 * The pids that share a folder AND a program with another pid.
 *
 * Same program as well as same folder: an editor's dev server and its test
 * runner both start in the checkout and neither is a leftover of the other. Two
 * `python` servers over one directory are, and so are two `vite`s in one
 * checkout. A pid on two addresses (v4 and v6) is one listener, not two.
 * What it cannot see: the same directory served by different programs.
 */
export function duplicatePids(rows: readonly Twinnable[]): Set<number> {
  const by = new Map<string, Set<number>>();
  for (const r of rows) {
    if (!r.mine || r.pid == null || !r.dir || !r.proc) continue;
    const key = `${r.proc}\0${r.dir}`;
    (by.get(key) ?? by.set(key, new Set()).get(key)!).add(r.pid);
  }
  const out = new Set<number>();
  for (const pids of by.values()) if (pids.size > 1) for (const p of pids) out.add(p);
  return out;
}

/** `ss -Htn state established`, as connections per local port. */
export function parseEstablished(out: string): Map<number, number> {
  const m = new Map<number, number>();
  for (const raw of out.split("\n")) {
    const cols = raw.trim().split(/\s+/);
    // With `state established` ss drops the State column: Recv-Q Send-Q Local Peer.
    const local = cols[2];
    if (!local) continue;
    const port = Number(local.slice(local.lastIndexOf(":") + 1));
    if (Number.isInteger(port) && port > 0) m.set(port, (m.get(port) ?? 0) + 1);
  }
  return m;
}

/** Idle: nothing has been connected for this long. */
export const IDLE_MS = 4 * 3_600_000;

/** Last time each listener was seen with a connection, by `pid:port`, plus the
 *  time of the sample itself under `SAMPLED`. */
export type LastSeen = Record<string, number>;
const SAMPLED = "@sampled";

/** Longer than this between two samples and the record cannot be trusted: the
 *  timer runs every five minutes, so a bigger gap is a laptop that slept or a
 *  clock that was stepped, and either would read as hours of idleness. */
export const MAX_SAMPLE_GAP_MS = 30 * 60_000;

/**
 * Fold one sample into the record.
 *
 * A listener seen for the FIRST time starts its clock now, however old the
 * process is: the tracker cannot know what happened before it looked, so a
 * server that has been quiet all week is flagged four hours after it was first
 * sampled, not at once. That is the ceiling of sampling; `ageSec` beside it in
 * the row is what covers the gap. Listeners no longer present are dropped, so a
 * reused pid does not inherit a dead server's clock.
 *
 * A gap since the last sample that is negative or over `MAX_SAMPLE_GAP_MS`
 * starts every clock again. Measured on this machine: the wall clock stepped
 * by hours between two samples, and every listener on it came back "idle".
 */
export function foldSample(
  prevIn: LastSeen,
  live: readonly { key: string; connections: number }[],
  now: number,
): LastSeen {
  const gap = prevIn[SAMPLED] == null ? 0 : now - prevIn[SAMPLED]!;
  const prev = gap < 0 || gap > MAX_SAMPLE_GAP_MS ? {} : prevIn;
  const next: LastSeen = { [SAMPLED]: now };
  for (const l of live) next[l.key] = l.connections > 0 || prev[l.key] == null ? now : prev[l.key]!;
  return next;
}

export function idleFor(seen: LastSeen, key: string, now: number, limit = IDLE_MS): number | null {
  const at = seen[key];
  return at != null && now - at >= limit ? Math.round((now - at) / 1000) : null;
}

// ---------------------------------------------------------------- persist ----
// One JSON file in the state directory, best effort: the record is a nicety, and
// losing it only restarts the clocks. The directory is the one browserdrive uses
// for its ledger (`AGENTGLASS_STATE_DIR` IS the directory), so a probe pointed at
// a scratch state dir never touches the real one.

function stateFile(): string {
  const dir = process.env.AGENTGLASS_STATE_DIR
    || join(process.env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "agentglass");
  return join(dir, "ports-last-seen.json");
}

export function readLastSeen(): LastSeen {
  try {
    const raw = JSON.parse(readFileSync(stateFile(), "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: LastSeen = {};
    for (const [k, v] of Object.entries(raw)) if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
    return out;
  } catch { return {}; }
}

export function writeLastSeen(s: LastSeen): void {
  try {
    const f = stateFile();
    if (!existsSync(dirname(f))) mkdirSync(dirname(f), { recursive: true });
    const tmp = `${f}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(s) + "\n");
    renameSync(tmp, f);
  } catch { /* remembering is a nicety */ }
}
