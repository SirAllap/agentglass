// Which transcripts need reading, decided from file-watch events.
//
// Pure on purpose: the sweep used to find out by stat-ing every transcript on a
// timer. Measured over a real ~/.claude/projects: 3161 directories, 3231
// transcripts (12 GB), and the stall log charged 55 stalls / 254 s (worst 32 s)
// to the "transcript sweep" label. Watching the directories replaces the stat
// loop; these functions are the decisions around it, kept free of fs and timers
// so a test can drive them with fixtures.
//
// Bun 1.3.9 on Linux, measured with a throwaway script:
//   - fs.watch(dir, { recursive: true }) reports a file one level down and
//     NOTHING from a directory created after the watch or from two levels down.
//     Subagent transcripts live three levels down
//     (<project>/<session>/subagents/*.jsonl), so recursive is not usable.
//   - one non-recursive watcher per directory reports every append and every
//     create, and 3500 of them opened at once without hitting a limit
//     (max_user_watches is 524288 here; the real tree needs ~3200).
// So the watcher is one per directory, and a directory that appears is watched
// when its parent reports it.
//
// Measured later on the real server: Bun's fs.watch(dir) also opens a handle
// per ENTRY of that directory (50 files + 30 dirs gave 85 descriptors), which
// was 19,504 descriptors and constant wakeups for a 3200-directory tree. The
// watcher now uses one inotify instance (inotify.ts): no handle per entry.

import { join } from "node:path";

export type WatchVerdict =
  | { kind: "file"; path: string }
  | { kind: "dir"; path: string }
  | { kind: "ignore" };

/** What one fs.watch event on `dir` means. `name` is null when the platform did
 *  not say which entry changed; the whole directory is then looked at again.
 *  A name ending in .jsonl is a transcript. A name with no dot is a possible
 *  directory (session ids and `subagents` have none). Anything else —
 *  `tool-results/abc.txt`, `.meta` — is not ours and costs nothing. */
/** Directories under a project that never hold a transcript. They are not
 *  watched: a Bun watcher held one handle per entry in them. */
export const NON_TRANSCRIPT_DIRS: ReadonlySet<string> = new Set(["tool-results", "memory"]);

export function judgeWatchEvent(dir: string, name: string | null): WatchVerdict {
  if (name === null || name === "") return { kind: "dir", path: dir };
  const path = join(dir, name);
  if (name.endsWith(".jsonl")) return { kind: "file", path };
  if (NON_TRANSCRIPT_DIRS.has(name)) return { kind: "ignore" };
  if (!name.includes(".")) return { kind: "dir", path };
  return { kind: "ignore" };
}

export type TickPlan = "idle" | "dirty" | "reconcile";

/** What the sweep timer does now.
 *  - A reconcile (a full walk, the net under missed events) is due only when
 *    the app is in use: nobody looking means nothing is late.
 *  - Otherwise dirty files are read, and with none the tick costs nothing. */
export function planTick(s: {
  dirty: number;
  dirDirty: number;
  now: number;
  lastReconcile: number;
  reconcileMs: number;
  inUse: boolean;
}): TickPlan {
  if (s.inUse && s.now - s.lastReconcile >= s.reconcileMs) return "reconcile";
  return s.dirty > 0 || s.dirDirty > 0 ? "dirty" : "idle";
}

/** Files one watch-driven sweep reads. A sweep finishes its list before the
 *  next one starts, so this is also the longest a transcript that changed just
 *  now waits behind a bulk of older marks: ~2000 small files measured well
 *  under a second of reads, spread over the sweep's own yields. */
export const DIRTY_CHUNK = 2000;

/**
 * Take the most recently marked `max` paths out of `dirty`, newest mark first.
 *
 * A Set keeps insertion order and the watcher moves a path to the end each
 * time it is marked, so the end of the set is what changed last. What is not
 * taken stays for the next sweep; nothing is dropped. Ceiling: the order is the
 * order of the marks, not of the files' mtimes, so inside one bulk discovery
 * (a directory listed at once) it is the listing's order.
 */
export function takeNewest(dirty: Set<string>, max: number): string[] {
  if (dirty.size <= max) {
    const all = [...dirty].reverse();
    dirty.clear();
    return all;
  }
  const taken = [...dirty].slice(-Math.max(1, max));
  for (const p of taken) dirty.delete(p);
  return taken.reverse();
}
