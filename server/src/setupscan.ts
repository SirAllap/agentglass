/*
 * `Search this computer`: one walk over the home folder, reporting as it goes.
 *
 * The walk is the machine search's own rules (`diskRoots`, `diskAllows`,
 * `skippedDir`, `isRepo`) with the Finder's own budget: six levels, 500
 * repositories, 20 seconds. It yields between directories so a GET can report
 * while it runs, and there is one scan per server — a second start answers the
 * first rather than walking the disk twice. Nothing is written and nothing is
 * kept after the process ends.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { SetupScan, SetupScanRow } from "../../shared/types.ts";
import { SETUP_SCAN_DEPTH, SETUP_SCAN_MAX_REPOS, SETUP_SCAN_MS, SETUP_SCAN_SKIPS } from "../../shared/setupScan.ts";
import { diskAllows, diskRoots } from "./disk.ts";
import { isRepo } from "./fsbrowse.ts";
import { skippedDir } from "./gitwork.ts";

/** Test seams: a small cap makes "it stopped and said so" provable in a
 *  second, and the bounds keep a typo from turning the walk loose. */
const capRepos = (() => {
  const n = Number(process.env.AGENTGLASS_SETUP_SCAN_MAX);
  return Number.isFinite(n) && n > 0 ? Math.min(5000, Math.floor(n)) : SETUP_SCAN_MAX_REPOS;
})();
const capMs = (() => {
  const n = Number(process.env.AGENTGLASS_SETUP_SCAN_MS);
  return Number.isFinite(n) && n > 0 ? Math.min(120_000, Math.floor(n)) : SETUP_SCAN_MS;
})();

interface Scan {
  id: string;
  state: SetupScan["state"];
  roots: string[];
  folders: number;
  current: string;
  repos: SetupScanRow[];
  capped: SetupScan["capped"];
  startedAt: number;
  endedAt: number;
  error?: string;
  stop: boolean;
  walker: Promise<void> | null;
}

let active: Scan | null = null;
let next = 0;

/** The git dir of a checkout — `.git` itself, or the one a worktree names. */
function gitDirOf(root: string): string | null {
  const dot = join(root, ".git");
  try {
    if (statSync(dot).isDirectory()) return dot;
  } catch {
    return null;
  }
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(readFileSync(dot, "utf8"));
    if (!m) return null;
    const target = m[1]!.trim();
    return isAbsolute(target) ? target : resolve(root, target);
  } catch {
    return null;
  }
}

/**
 * A row's branch and age with no git process: `HEAD` names the branch and the
 * reflog's mtime is the last time work happened here. A Finder lists hundreds
 * of rows, and one `git status` each would outlast the walk.
 */
function rowOf(root: string): SetupScanRow {
  const dir = gitDirOf(root);
  let branch = "(no commits)";
  let touchedAt = 0;
  if (dir) {
    try {
      const head = readFileSync(join(dir, "HEAD"), "utf8").trim();
      const named = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
      branch = named ? named[1]! : /^[0-9a-f]{7,40}$/i.test(head) ? "(detached)" : "(no commits)";
    } catch {
      /* an unreadable HEAD is a repository with no branch to show */
    }
    for (const file of ["logs/HEAD", "HEAD"]) {
      try {
        touchedAt = Math.max(touchedAt, statSync(join(dir, file)).mtimeMs);
      } catch {
        /* no reflog yet: an empty checkout */
      }
    }
  }
  return { name: basename(root), root, parent: dirname(root), branch, touchedAt: Math.round(touchedAt) };
}

function view(s: Scan): SetupScan {
  return {
    id: s.id,
    state: s.state,
    roots: [...s.roots],
    folders: s.folders,
    current: s.current,
    repos: s.repos.map((r) => ({ ...r })),
    capped: s.capped,
    startedAt: s.startedAt,
    elapsedMs: (s.endedAt || Date.now()) - s.startedAt,
    skips: [...SETUP_SCAN_SKIPS],
    ...(s.error ? { error: s.error } : {}),
  };
}

/** The walk, one directory at a time. Depths are below a root, and a checkout
 *  owns everything under it — the same rule the project picker uses. */
async function walk(s: Scan): Promise<void> {
  const queue = s.roots.map((dir) => ({ dir, depth: 0 }));
  let at = 0;
  while (at < queue.length) {
    if (s.stop) {
      s.state = "stopped";
      s.capped = "person";
      break;
    }
    if (Date.now() - s.startedAt >= capMs) {
      s.state = "stopped";
      s.capped = "time";
      break;
    }
    if (s.repos.length >= capRepos) {
      s.state = "stopped";
      s.capped = "count";
      break;
    }
    const { dir, depth } = queue[at++]!;
    s.current = dir;
    s.folders++;
    if (isRepo(dir)) {
      s.repos.push(rowOf(dir));
      continue;
    }
    if (depth >= SETUP_SCAN_DEPTH) continue;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      // A symlink is not followed: it can leave the root and the budget, and
      // the machine search refuses one that points outside for the same reason.
      if (!ent.isDirectory() || ent.isSymbolicLink()) continue;
      if (skippedDir(ent.name)) continue;
      const path = resolve(dir, ent.name);
      if (!diskAllows(path)) continue;
      queue.push({ dir: path, depth: depth + 1 });
    }
    // Hand the event loop back: a GET must be able to report mid-walk.
    if (s.folders % 40 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  if (s.state === "running") s.state = "done";
  s.endedAt = Date.now();
}

/** Start a search, or answer the one already running. */
export function setupScanStart(): SetupScan {
  if (active && active.state === "running") return view(active);
  const s: Scan = {
    id: `scan-${++next}`,
    state: "running",
    roots: diskRoots().map((r) => resolve(r)),
    folders: 0,
    current: "",
    repos: [],
    capped: null,
    startedAt: Date.now(),
    endedAt: 0,
    stop: false,
    walker: null,
  };
  active = s;
  if (!s.roots.length) {
    s.state = "failed";
    s.error = "This machine turns the folder search off.";
    s.endedAt = Date.now();
    return view(s);
  }
  s.walker = walk(s).catch((e) => {
    s.state = "failed";
    s.error = e instanceof Error ? e.message : String(e);
    s.endedAt = Date.now();
  });
  return view(s);
}

/** One search by id, or null when this server never started it. */
export function setupScanGet(id: unknown): SetupScan | null {
  if (typeof id !== "string" || !id || !active || active.id !== id) return null;
  return view(active);
}

/** Stop a running search. The walker leaves at its next directory, so the
 *  answer is the same scan with nothing more to add. */
export function setupScanStop(id: unknown): SetupScan | null {
  if (typeof id !== "string" || !id || !active || active.id !== id) return null;
  active.stop = true;
  if (active.state === "running") {
    active.state = "stopped";
    active.capped = "person";
    active.endedAt = Date.now();
  }
  return view(active);
}
