/*
 * The Left behind list's fold. One test run leaves thirty-one `sleep 1` behind,
 * and thirty-one identical rows bury the finding; rows that share a command and
 * a cwd state (gone or still there) become one row carrying the count, with the
 * pids kept inside it so Stop still reaches every one.
 *
 * A temp wrapper is folded on the helper's own name instead: each wrapper's
 * command carries its own temp path, so 43 `gio mount -m` rows would otherwise
 * be 43 rows and push the rest of the list under "Show all".
 *
 * The order is the server's: a hot group is already where it should be.
 */
import type { OrphanProc } from "../../../shared/types.ts";

/** Folded rows shown before the list offers "Show all". */
export const LEFT_ROWS = 8;

/** The server's sentence for this origin; the fold needs to recognise it. */
const WRAPPER = "a throwaway wrapper in a temp directory";

export interface LeftGroup {
  key: string;
  cmd: string;
  cwdGone: boolean;
  procs: OrphanProc[];
  count: number;
  /** The oldest in the group; null until one of them has an age. */
  oldestSec: number | null;
  /** What the group adds up to, not its hottest member; null unless every member
   *  has a sample, since a member read as 0% would understate the group. */
  cpu: number | null;
  hot: boolean;
  /** Every distinct reason in the group, in the order they appeared. */
  reasons: string[];
}

const base = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

/** `gio mount -m` from `/bin/sh /tmp/agx-volumes-x/bin/gio mount -m`: the temp
 *  path is the wrapper's, not part of what the helper was asked to do. */
const wrapperCmd = (p: OrphanProc): string => {
  const words = (p.cmd || p.comm).split(/\s+/);
  const at = words.findIndex((w) => base(w) === p.comm);
  return at < 0 ? p.comm : words.slice(at).map((w, i) => (i === 0 ? base(w) : w)).join(" ");
};

const keyOf = (p: OrphanProc): string =>
  `${p.origin === WRAPPER ? `wrapper:${p.comm}` : p.cmd || p.comm}\u0000${p.cwdGone ? "gone" : "live"}`;

export function foldLeftBehind(procs: readonly OrphanProc[]): LeftGroup[] {
  const by = new Map<string, LeftGroup>();
  for (const p of procs) {
    const key = keyOf(p);
    const cmd = p.origin === WRAPPER ? wrapperCmd(p) : p.cmd || p.comm;
    const g = by.get(key);
    if (!g) {
      by.set(key, {
        key, cmd, cwdGone: p.cwdGone, procs: [p], count: 1,
        oldestSec: p.ageSec, cpu: p.cpu, hot: p.hot, reasons: [...p.reasons],
      });
      continue;
    }
    g.procs.push(p);
    g.count += 1;
    if (p.ageSec != null && (g.oldestSec == null || p.ageSec > g.oldestSec)) g.oldestSec = p.ageSec;
    if (p.cpu != null && g.cpu != null) g.cpu += p.cpu;
    else g.cpu = null;
    g.hot = g.hot || p.hot;
    for (const r of p.reasons) if (!g.reasons.includes(r)) g.reasons.push(r);
  }
  return [...by.values()];
}

/** `sleep 1 x 31`; a group of one keeps the command alone, the way the row always read. */
export const leftTitle = (g: LeftGroup): string => (g.count > 1 ? `${g.cmd} x ${g.count}` : g.cmd);

/** The rows on screen, and how many the "Show all" toggle would add. */
export function shownLeft(groups: readonly LeftGroup[], showAll: boolean): { rows: LeftGroup[]; hidden: number } {
  const rows = showAll ? [...groups] : groups.slice(0, LEFT_ROWS);
  return { rows, hidden: groups.length - rows.length };
}
