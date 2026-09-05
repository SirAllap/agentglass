/*
 * Finding a file that is not in any checkout.
 *
 * The finder answers three questions about the repository you are working in,
 * and there was a fourth it kept sending people out of the app to answer:
 * "where is that document". The evidence folder for a ticket, the note in
 * ~/Documents, the export somebody dropped in ~/Downloads — none of them live
 * in a git checkout, so none of them were reachable, and reading one meant
 * leaving for a file manager and coming back to find your place again. Which
 * is the exact trip the palette exists to remove.
 *
 * Everything else under /files/ is bounded by the open project on purpose (see
 * config.ts): a cockpit pointed at one repository must not hand out reads of
 * the whole machine through a different door. This is the deliberate
 * exception, and it is narrow on purpose:
 *
 *   HOME, and nothing above it   Your own documents, not the machine's. Extra
 *                                roots exist for the person whose work lives
 *                                on another mount — but they are named by the
 *                                operator, not discovered.
 *   nothing hidden               A dotted path component is where credentials
 *                                live: ~/.ssh, ~/.aws, ~/.config/<app>,
 *                                ~/.claude/.credentials.json. The rule is the
 *                                dot rather than a list of names, because a
 *                                list is only ever as good as the last app
 *                                that was installed. Anybody who genuinely
 *                                wants a dotfile has a shell one chord away.
 *   symlinks resolved first      Otherwise ~/shortcut-to-etc walks around both
 *                                of the rules above while looking like a
 *                                folder in your home directory.
 *   its own switch               AGENTGLASS_DISK_DISABLED=1. Same reasoning as
 *                                fsbrowse.ts: an operator who turned directory
 *                                browsing off has given something up
 *                                deliberately, and must not get it back
 *                                sideways because a new tab appeared.
 *
 * Measured on this machine before any of it was written: `fd` over a home
 * directory answers a query matching NOTHING in 0.19s — every file walked,
 * nothing found — and a query that does match stops earlier still. So there is
 * no index here and no cache: the walk is cheaper than the bookkeeping to
 * avoid it would be.
 */

import { readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { safeAbs } from "./git.ts";
import type { FindReport } from "./files.ts";
import type { GrepHit, GrepReport } from "../../shared/types.ts";

/** Kill switch, independent of the terminal's and of the file browser's.
 *
 *  A function rather than a constant read at import: a constant is decided by
 *  whichever test file imported this module first, and a switch nobody can
 *  toggle is a switch nobody can test. Reading an env var is nothing. */
export const diskEnabled = (): boolean => process.env.AGENTGLASS_DISK_DISABLED !== "1";

/** Enough to pick from; few enough that "e" cannot turn one keystroke into a
 *  megabyte of JSON. `fd --max-results` stops the walk at this number rather
 *  than finishing it and throwing the rest away. */
const MAX_RESULTS = 300;

/** One letter matches most of a home directory, which is not a search result.
 *  Same floor the content search uses. */
const MIN_QUERY = 2;

/**
 * This process's home directory.
 *
 * `$HOME` first, and `os.homedir()` only as the fallback — deliberately, twice
 * over. It is what the user's own shell means by `~`, so the boundary here and
 * the paths they type agree; and Bun answers `os.homedir()` from a value it
 * settled at start-up, which a test cannot move, so a boundary written on top
 * of it is a boundary nobody can prove. Whoever can set this process's HOME
 * already owns the process.
 */
const home = (): string => process.env.HOME || homedir();

const expandHome = (p: string): string =>
  p === "~" ? home() : p.startsWith("~/") ? join(home(), p.slice(2)) : p;

/**
 * Where the machine search may look.
 *
 * HOME always; anything in `AGENTGLASS_DISK_ROOTS` (`:`-separated) as well, for
 * the machine whose projects and papers live on another mount. Naming a root
 * there is an operator's decision and is taken at face value — including a
 * hidden one, since the hidden rule below is about what a search *wanders*
 * into, not about what someone deliberately pointed it at.
 */
export function diskRoots(): string[] {
  if (!diskEnabled()) return [];
  const extra = (process.env.AGENTGLASS_DISK_ROOTS || "")
    .split(":").map((s) => s.trim()).filter(Boolean)
    .map((p) => resolve(expandHome(p)));
  return [home(), ...extra];
}

/** Is `p` inside `root` — after resolution, so "/a/bc" is not inside "/a/b". */
function within(p: string, root: string): boolean {
  const back = relative(root, p);
  return back === "" || (!back.startsWith("..") && !isAbsolute(back));
}

/**
 * The path with its symlinks resolved — including for a file that does not
 * exist yet, by resolving the deepest ancestor that does.
 *
 * A read of a missing file has to be refused with "no such file" rather than
 * with "outside", and that difference is only knowable after the containment
 * check has been given something real to check.
 */
function realish(abs: string): string {
  let head = abs;
  const tail: string[] = [];
  for (let i = 0; i < 64; i++) {
    try { return join(realpathSync(head), ...tail); } catch { /* climb */ }
    const up = dirname(head);
    if (up === head) return abs;
    tail.unshift(head.slice(up.length + 1));
    head = up;
  }
  return abs;
}

/**
 * May the machine search touch this path?
 *
 * Asked of the root of a search AND of every path it hands back, because the
 * two are different questions once symlinks exist: a search rooted at
 * ~/Documents is allowed, and a symlink inside it pointing at /etc is not.
 */
export function diskAllows(p: unknown): boolean {
  const abs = safeAbs(p);
  if (!abs) return false;
  const real = realish(abs);
  return diskRoots().some((root) => {
    if (!within(real, root)) return false;
    // Hidden is measured from the ROOT, not from "/": a root the operator named
    // may itself be dotted, and that is their call — see diskRoots.
    return !relative(root, real).split(sep).some((seg) => seg.startsWith("."));
  });
}

export interface DiskPlace {
  path: string;
  /** What to call it in a menu — "Home", or the folder's own name. */
  label: string;
}

export interface DiskPlaces {
  ok: boolean;
  home: string;
  /** Everywhere a search may be rooted, in full. */
  roots: string[];
  /** Somewhere to start from without typing a path: the roots, plus the
   *  handful of home folders that actually exist on this machine. A suggestion
   *  list, not the boundary — the boundary is `roots`. */
  places: DiskPlace[];
  error?: string;
}

/** The usual homes for documents. Listed rather than guessed at, and every one
 *  of them is checked against the disk before it is offered — a menu row for a
 *  folder that is not there is a dead end wearing a name. */
const HOME_FOLDERS = ["Documents", "Desktop", "Downloads", "Projects", "code", "src", "Notes"];

export function diskPlaces(): DiskPlaces {
  const at = home();
  if (!diskEnabled()) {
    return { ok: false, home: at, roots: [], places: [], error: "searching the machine is disabled (AGENTGLASS_DISK_DISABLED=1)" };
  }
  const roots = diskRoots();
  const places: DiskPlace[] = [];
  const add = (path: string, label: string) => {
    if (places.some((p) => p.path === path)) return;
    try { if (!statSync(path).isDirectory()) return; } catch { return; }
    places.push({ path, label });
  };
  for (const r of roots) add(r, r === at ? "Home" : r.split(sep).pop() || r);
  for (const name of HOME_FOLDERS) add(join(at, name), name);
  return { ok: true, home: at, roots, places };
}

/** Directories a machine-wide walk has no business descending into. `fd`
 *  already skips hidden files and anything a .gitignore covers, which is what
 *  makes the measured walk fast; these are the ones that survive both. */
const SKIP = new Set(["node_modules", "__pycache__", "Trash"]);

/**
 * Files and folders under `root` whose PATH contains `q`.
 *
 * Deliberately not `findFiles` with a flag: that one searches a checkout, is
 * bounded by the open project, includes hidden files and falls back to
 * `git ls-files` — every one of which is right there and wrong here. The two
 * hand back the same shape and answer different questions.
 */
export function diskFind(rootIn: unknown, qIn: unknown, limit = MAX_RESULTS): FindReport {
  const no = (error: string): FindReport => ({ ok: false, files: [], dirs: [], truncated: false, via: "", error });
  if (!diskEnabled()) return no("searching the machine is disabled (AGENTGLASS_DISK_DISABLED=1)");

  const root = safeAbs(rootIn);
  if (!root) return no("no folder given");
  try { if (!statSync(root).isDirectory()) return no("not a folder"); }
  catch { return no("no such folder"); }
  /* Only the roots above, and NOT "anything the open project already allows".
   *
   * The tempting version of that line accepts an in-scope checkout too, on the
   * grounds that this tab should not be the one place in the app that cannot
   * look at the project. It is wrong twice over: the Name tab is where a
   * checkout is searched, and — since an UNSCOPED instance is in scope
   * everywhere — it would quietly turn this into a search of the whole disk on
   * the default install. One boundary, written once. */
  if (!diskAllows(root)) {
    return no(`outside what this search may read (${diskRoots().join(", ") || "nothing"})`);
  }

  const q = typeof qIn === "string" ? qIn.trim() : "";
  if (q.length < MIN_QUERY) return { ok: true, files: [], dirs: [], truncated: false, via: "" };

  const keep = (rel: string): boolean => diskAllows(join(root, rel));

  const fd = Bun.which("fd") ?? Bun.which("fdfind");
  if (fd) {
    // No --hidden, unlike the checkout search: a dotted path is refused on the
    // way back out anyway, so walking into ~/.cache would only spend time to
    // produce results nobody is allowed to open.
    const args = [fd, "--full-path", "--fixed-strings", "--max-results", String(limit + 1)];
    for (const s of SKIP) args.push("--exclude", s);
    // After `--`, always: the query is typed by whoever holds the token, and
    // `q=--search-path=/etc` handed to fd as a bare word was an option, not a
    // pattern — it listed /etc, and `keep()` let every line through because
    // `join(root, "/etc/x")` is a path under the root. The content search
    // below already did this for rg; this branch had not.
    args.push("--", q);
    const r = Bun.spawnSync(args, { cwd: root, stdout: "pipe", stderr: "pipe", timeout: 10_000 });
    const all = new TextDecoder().decode(r.stdout).split("\n").map((s) => s.trim()).filter(Boolean);
    const dirs: string[] = [];
    const files: string[] = [];
    for (const line of all.slice(0, limit)) {
      const isDir = line.endsWith("/");
      const rel = isDir ? line.replace(/\/+$/, "") : line;
      if (!keep(rel)) continue;
      (isDir ? dirs : files).push(rel);
    }
    return { ok: true, files, dirs, truncated: all.length > limit, via: "fd" };
  }

  return diskWalk(root, q, limit, keep);
}

/**
 * The same answer without `fd` installed.
 *
 * `findFiles` falls back to `git ls-files`, which knows nothing about a folder
 * that is not a repository — so this one walks. Exported for the test that
 * proves it: on a machine with `fd` installed nothing reaches it, which is
 * exactly how a fallback rots. Bounded on three axes rather
 * than one, because a home directory is not a checkout: a deadline, a cap on
 * directories entered, and the cap on results all end the walk, and the report
 * says it was cut short rather than pretending to be complete.
 */
export function diskWalk(root: string, q: string, limit = MAX_RESULTS, keep: (rel: string) => boolean = (rel) => diskAllows(join(root, rel))): FindReport {
  const needle = q.toLowerCase();
  const deadline = Date.now() + 4_000;
  const MAX_DIRS = 20_000;
  const files: string[] = [];
  const dirs: string[] = [];
  const queue: string[] = [""];
  let entered = 0;
  let truncated = false;

  while (queue.length) {
    if (files.length + dirs.length >= limit || entered >= MAX_DIRS || Date.now() > deadline) { truncated = true; break; }
    const rel = queue.shift()!;
    entered++;
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(join(root, rel), { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
      const child = rel ? `${rel}/${e.name}` : e.name;
      const dir = e.isDirectory();
      if (dir) queue.push(child);
      if (!child.toLowerCase().includes(needle)) continue;
      if (!keep(child)) continue;
      if (dir) dirs.push(child); else if (e.isFile()) files.push(child);
    }
  }
  return { ok: true, files, dirs, truncated, via: "walk" };
}

/* -------------------------------------------------------------------------
 * Searching the CONTENTS of documents outside the checkout.
 *
 * The Contents tab only ever looked inside the open repository, so notes, PoLs
 * and anything else in ~/Documents could be found by name and not by what it
 * says — which is how nobody looks for a note. Same boundary as diskFind: the
 * root must be allowed, and every hit is checked again on the way out, because
 * a symlink inside an allowed folder is not an allowed folder.
 * ---------------------------------------------------------------------- */

/** Hits per search. Past this it is not a result, it is a corpus. */
const MAX_GREP_HITS = 200;

export function diskGrep(rootIn: unknown, qIn: unknown, limit = MAX_GREP_HITS): GrepReport {
  const empty = { ok: false, hits: [] as GrepHit[], files: 0, truncated: false, via: "" };
  if (!diskEnabled()) return { ...empty, error: "searching the machine is disabled (AGENTGLASS_DISK_DISABLED=1)" };
  const root = safeAbs(rootIn);
  if (!root || !diskAllows(root)) return { ...empty, error: "outside the places this may search" };
  const q = typeof qIn === "string" ? qIn.trim() : "";
  // Two characters, the same floor the repository search uses: one letter
  // matches every file on the machine, which is not a search result.
  if (q.length < 2) return { ok: true, hits: [], files: 0, truncated: false, via: "" };

  const rg = Bun.which("rg", { PATH: process.env.PATH ?? "" });
  const argv = rg
    ? [rg, "--fixed-strings", "--ignore-case", "--line-number", "--no-heading", "--with-filename",
       "--color", "never", "--max-count", "5", "--max-filesize", "4M", "-I",
       // Hidden paths are excluded by the boundary itself; saying so to ripgrep
       // as well means it never even walks ~/.cache, which is most of the time.
       "--no-hidden", "--", q, root]
    // `grep -r` is the fallback, not the plan: it has no size limit and no
    // binary skip worth the name, so the caps below do the work instead.
    : ["grep", "-rInI", "--", q, root];
  const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe", timeout: 20_000 });

  const hits: GrepHit[] = [];
  const files = new Set<string>();
  const needle = q.toLowerCase();
  let truncated = false;
  for (const line of r.stdout.toString().split("\n")) {
    if (!line) continue;
    if (hits.length >= limit) { truncated = true; break; }
    // path:line:text — and a Windows-style drive letter cannot appear here, so
    // the first two colons are the separators.
    const first = line.indexOf(":");
    const second = line.indexOf(":", first + 1);
    if (first < 0 || second < 0) continue;
    const abs = line.slice(0, first);
    const at = Number(line.slice(first + 1, second));
    const text = line.slice(second + 1);
    if (!Number.isFinite(at) || !diskAllows(abs)) continue;
    files.add(abs);
    const idx = text.toLowerCase().indexOf(needle);
    hits.push({ rel: abs, line: at, text: text.slice(0, 400), at: idx < 0 ? 0 : idx, len: idx < 0 ? 0 : q.length });
  }
  return { ok: true, hits, files: files.size, truncated, via: rg ? "rg" : "grep" };
}
