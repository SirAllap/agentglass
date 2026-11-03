/*
 * The net under the ledger, for a helper no ledger row names.
 *
 * Measured on one machine 12.5 h after the ledger landed: four
 * `/usr/bin/udisksctl monitor` alive with the user's systemd as their parent
 * (`systemd --user`, pid 1487), all older than the fix, and no
 * `children.*.json` in the state dir — so the boot reap had nothing to read and
 * the four stayed. Nothing grows now: the spawn carries a parent-death signal.
 *
 * A line is ours only when its argv is exactly one this server starts, it
 * belongs to this user, and its parent is init or this user's own systemd —
 * which is what an orphan looks like. A helper of a server still running has
 * that server as its parent and is never touched, and neither is anything
 * another user started. A name alone is not evidence: `gio` also opens files,
 * and this desktop starts its own `inotifywait`, so the command lines are
 * written down one by one.
 */
import { STOP_GRACE_MS, startStamp } from "./childledger.ts";

/** The exact tail of each long-lived helper this server starts, from the two
 *  `watchDevices` spawns in volumes.ts; change them together. argv[0] is
 *  compared by basename. `inotifywait` is absent: nothing here starts one. */
export const OWN_HELPERS: ReadonlyArray<readonly string[]> = [
  ["udisksctl", "monitor"],
  ["gio", "mount", "-m"],
];

/** `ps` columns, in this order, with `=` so there is no header to skip. */
const PS_FORMAT = "pid=,ppid=,uid=,comm=,args=";

export interface PsRow {
  pid: number;
  ppid: number;
  uid: number;
  comm: string;
  /** The command line, arguments joined by spaces as `ps` prints them. */
  cmd: string;
}

export interface HelperContext {
  selfPid: number;
  uid: number;
  /** pids that mean "nobody owns this any more": init and this user's systemd.
   *  A running server is never one of these — its helper carries it as ppid. */
  initPids: number[];
}

export function parsePs(text: string): PsRow[] {
  const out: PsRow[] = [];
  for (const line of text.split("\n")) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), uid: Number(m[3]), comm: m[4]!, cmd: (m[5] ?? "").trim() });
  }
  return out;
}

/** Init and the user's `systemd --user`: both have init as their own parent. */
export function initPidsOf(rows: PsRow[]): number[] {
  return rows.filter((r) => r.pid === 1 || (r.comm === "systemd" && r.ppid === 1)).map((r) => r.pid);
}

/** The exact argv this server starts, or null. Arguments here carry no spaces,
 *  so `ps`'s joining is unambiguous for these five words. */
function ownArgv(cmd: string): string[] | null {
  const argv = cmd.split(/\s+/).filter(Boolean);
  if (!argv.length) return null;
  const exe = argv[0]!.split("/").pop() ?? "";
  for (const want of OWN_HELPERS) {
    if (exe === want[0] && argv.slice(1).join("\u0000") === want.slice(1).join("\u0000")) return argv;
  }
  return null;
}

export function classifyOwnHelpers(rows: PsRow[], ctx: HelperContext): PsRow[] {
  const init = new Set(ctx.initPids);
  return rows.filter((r) =>
    r.pid !== ctx.selfPid
    && r.uid === ctx.uid
    && init.has(r.ppid)
    && ownArgv(r.cmd) !== null);
}

function readPs(): string {
  const r = Bun.spawnSync(["ps", "-eo", PS_FORMAT], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 5_000 });
  return r.success ? r.stdout.toString() : "";
}

export interface ReapDeps {
  ps?: () => string;
  signal?: (pid: number, sig: NodeJS.Signals) => void;
  startOf?: (pid: number) => string;
  graceMs?: number;
}

/** SIGTERM every orphaned helper, then SIGKILL after the grace only the ones
 *  still there and still the same process. Returns how many were asked to stop. */
export function reapOwnHelpers(deps: ReapDeps = {}): number {
  const ps = deps.ps ?? readPs;
  const signal = deps.signal ?? ((pid: number, sig: NodeJS.Signals) => { process.kill(pid, sig); });
  const startOf = deps.startOf ?? startStamp;
  const graceMs = deps.graceMs ?? STOP_GRACE_MS;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const mineIn = (text: string): PsRow[] => {
    const rows = parsePs(text);
    return classifyOwnHelpers(rows, { selfPid: process.pid, uid, initPids: initPidsOf(rows) });
  };

  let text: string;
  try { text = ps(); } catch { return 0; }
  const starts = new Map<number, string>();
  let stopped = 0;
  for (const row of mineIn(text)) {
    const start = startOf(row.pid);
    // No start time means no way to tell this pid from a reused one later.
    if (!start) continue;
    starts.set(row.pid, start);
    try { signal(row.pid, "SIGTERM"); stopped++; } catch { /* it went in between */ }
  }
  if (stopped === 0) return 0;

  const settle = () => {
    let again: PsRow[];
    try { again = mineIn(ps()); } catch { return; }
    for (const row of again) {
      const start = starts.get(row.pid);
      if (start === undefined || startOf(row.pid) !== start) continue;
      try { signal(row.pid, "SIGKILL"); } catch { /* gone */ }
    }
  };
  setTimeout(settle, graceMs).unref?.();
  return stopped;
}
