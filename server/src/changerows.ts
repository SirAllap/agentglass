/*
 * What changed, and — separately — what the change says.
 *
 * The Diff view used to ask one question and get both answers at once: a list of
 * rows with every file's full diff inside it. Measured on this machine, that was
 * 1.1 MB re-fetched every four seconds, of which 89% was diff text for files
 * nobody had opened, to render the one file that was selected. Splitting the two
 * is most of what this module is.
 *
 * The rest is honesty about the fields. The old list described a changed file
 * with the shape used for an agent's Edit call — an event, with a database id, a
 * session and the timestamp of the hook that recorded it — and git rows had none
 * of those, so each was invented at the point of use: the stamp became
 * `Date.now()`, the session became the string "staged", and the id became a hash
 * of the two. Every invention became a visible bug (all times equal to the
 * current clock; sections labelled `git:unstaged`; `git add` changing a row's
 * identity and taking the selection and the review tick with it). So every field
 * here is read from git or from the filesystem, and where there is no answer the
 * field says so rather than guessing.
 *
 * Nothing here spawns a `git diff` that produces patch text for a list. Status
 * and counts come from `--porcelain=v2` and `--numstat`, which is a fraction of
 * the work and none of the payload.
 */

import { statSync, readFileSync } from "node:fs";
import { resolve, dirname, sep } from "node:path";
import { gitAsync } from "./git.ts";
import { inScope } from "./config.ts";
import type { ChangeRow, ChangeRowsResult, FileDiff, DiffHunk, GitRepoRef } from "../../shared/types.ts";

/** Git's empty tree, so a repo's first commit (which has no parent) diffs as
 *  all-added instead of failing. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** An untracked file is all-added by definition, but nothing knows how many
 *  lines that is without reading it. Read up to this; past it the row says
 *  "too big" rather than costing a megabyte to produce a number. */
const UNTRACKED_COUNT_MAX = 128 * 1024;
/** And at most this many per repo, so a checkout that has just unpacked a build
 *  directory cannot turn one list request into ten thousand reads. */
const UNTRACKED_READ_MAX = 200;

/** Hard ceiling on a single file's diff. A generated lockfile with 40k changed
 *  lines is not something to render; saying it was cut is better than a browser
 *  that stops responding. */
const DIFF_MAX_LINES = 8000;

type Mode = "working" | "committed";

/* ── the wire format of `git status --porcelain=v2 -z` ────────────────────── */

type StatusEntry = {
  path: string;
  oldPath?: string;
  /** Index (staged) and worktree (unstaged) states, git's own two letters. */
  x: string;
  y: string;
  untracked: boolean;
};

/**
 * Parse porcelain v2.
 *
 * Two things make this worth writing out rather than eyeballing: a `2` (renamed)
 * record is followed by its ORIGINAL path as a separate NUL-terminated field, so
 * a naive split shifts every subsequent record by one; and the `u` (unmerged)
 * records have a different arity again. Both were worth getting right the first
 * time — a shifted parse does not throw, it silently attributes every file's
 * status to its neighbour.
 */
export function parseStatusV2(out: string): StatusEntry[] {
  const parts = out.split("\0");
  const rows: StatusEntry[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const kind = rec[0];
    if (kind === "1") {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      rows.push({ path: f.slice(8).join(" "), x: xy[0]!, y: xy[1]!, untracked: false });
    } else if (kind === "2") {
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>, then <origPath>
      const f = rec.split(" ");
      const xy = f[1] ?? "..";
      const path = f.slice(9).join(" ");
      const oldPath = parts[++i] ?? undefined;
      rows.push({ path, oldPath, x: xy[0]!, y: xy[1]!, untracked: false });
    } else if (kind === "u") {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const f = rec.split(" ");
      const xy = f[1] ?? "UU";
      rows.push({ path: f.slice(10).join(" "), x: xy[0]!, y: xy[1]!, untracked: false });
    } else if (kind === "?") {
      rows.push({ path: rec.slice(2), x: ".", y: "?", untracked: true });
    }
    // "!" (ignored) is never asked for, and "#" headers carry nothing this needs.
  }
  return rows;
}

/** git's two letters → the one word a reader wants. The worktree letter wins
 *  when they disagree, because that is the newer of the two states. */
function statusOf(e: StatusEntry): ChangeRow["status"] {
  if (e.untracked) return "untracked";
  const c = e.y !== "." ? e.y : e.x;
  if (c === "A") return "added";
  if (c === "D") return "deleted";
  if (c === "R" || e.oldPath) return "renamed";
  if (c === "T") return "typechange";
  if (c === "U") return "modified"; // unmerged: still a modification to read
  return "modified";
}

function stagedOf(e: StatusEntry): ChangeRow["staged"] {
  if (e.untracked) return "none";
  const inIndex = e.x !== ".";
  const inTree = e.y !== ".";
  return inIndex && inTree ? "partial" : inIndex ? "full" : "none";
}

/* ── counts ───────────────────────────────────────────────────────────────── */

type Counts = { add: number; del: number; binary: boolean };

/**
 * `git diff --numstat -z`, which answers in three shapes: `add\tdel\tpath` for an
 * ordinary file, `-\t-\tpath` for a binary one, and — for a rename — the two
 * counts followed by an EMPTY path field and then the from/to pair as two more
 * NUL-terminated fields. The last shape is the one that shifts a naive parse.
 */
export function parseNumstat(out: string): Map<string, Counts> {
  const map = new Map<string, Counts>();
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    const tab = rec.split("\t");
    if (tab.length < 3) continue;
    const [a, d] = tab;
    const binary = a === "-" || d === "-";
    const counts: Counts = { add: binary ? 0 : Number(a) || 0, del: binary ? 0 : Number(d) || 0, binary };
    let path = tab.slice(2).join("\t");
    if (!path) {
      // Rename: the next two fields are <from> and <to>. The row is filed under
      // the destination, which is where the file is now.
      i++; // from
      path = parts[++i] ?? "";
    }
    if (!path) continue;
    const prev = map.get(path);
    // Staged and unstaged are two answers about one file; the row shows the sum.
    map.set(path, prev
      ? { add: prev.add + counts.add, del: prev.del + counts.del, binary: prev.binary || counts.binary }
      : counts);
  }
  return map;
}

/* ── when ─────────────────────────────────────────────────────────────────── */

/**
 * When the file changed.
 *
 * mtime, because that is the only record of it that exists — git stores no such
 * thing for uncommitted work, which is precisely why the old view stamped the
 * time of the request and every row read as "now".
 *
 * A deleted file has no mtime, so its directory's stands in: the directory was
 * written when the file was removed from it. When even that fails the answer is
 * 0, and the view says "—" rather than inventing a third time.
 */
function changedAtOf(abs: string, deleted: boolean): number {
  try {
    if (!deleted) return Math.round(statSync(abs).mtimeMs);
  } catch { /* fall through to the directory */ }
  try { return Math.round(statSync(dirname(abs)).mtimeMs); } catch { return 0; }
}

/** Lines in an untracked file, or null when it is binary or not worth reading. */
function countUntracked(abs: string): { add: number; binary: boolean; tooBig: boolean } {
  let size = 0;
  try { size = statSync(abs).size; } catch { return { add: 0, binary: false, tooBig: false }; }
  if (size > UNTRACKED_COUNT_MAX) return { add: 0, binary: false, tooBig: true };
  let text: string;
  try { text = readFileSync(abs, "utf8"); } catch { return { add: 0, binary: true, tooBig: false }; }
  if (text.includes("\0")) return { add: 0, binary: true, tooBig: false };
  if (!text) return { add: 0, binary: false, tooBig: false };
  const n = text.split("\n").length;
  return { add: text.endsWith("\n") ? n - 1 : n, binary: false, tooBig: false };
}

/* ── one repo ─────────────────────────────────────────────────────────────── */

async function workingRows(repo: GitRepoRef, scope: string | null): Promise<ChangeRow[]> {
  const root = repo.root;
  const [status, unstaged, staged] = await Promise.all([
    gitAsync(root, ["-c", "core.quotePath=false", "status", "--porcelain=v2", "-z", "--untracked-files=all"]),
    gitAsync(root, ["-c", "core.quotePath=false", "diff", "--numstat", "-z"]),
    gitAsync(root, ["-c", "core.quotePath=false", "diff", "--cached", "--numstat", "-z"]),
  ]);
  if (status.code !== 0) throw new Error(status.stderr.trim() || "git status failed");

  const entries = parseStatusV2(status.stdout);
  const counts = parseNumstat(unstaged.stdout + "\0" + staged.stdout);
  const ignored = await ignoredSet(root, entries.filter((e) => !e.untracked).map((e) => e.path));

  let read = 0;
  return entries.map((e) => {
    const status = statusOf(e);
    const abs = resolve(root, e.path);
    const c = counts.get(e.path);
    let add = c?.add ?? 0, del = c?.del ?? 0, binary = c?.binary ?? false, tooBig = false;
    if (e.untracked && read < UNTRACKED_READ_MAX) {
      read++;
      const u = countUntracked(abs);
      add = u.add; binary = u.binary; tooBig = u.tooBig;
    } else if (e.untracked) {
      tooBig = true;
    }
    return {
      key: `${root}\0${e.path}`,
      repoRoot: root,
      branch: repo.branch || "",
      path: e.path,
      status,
      staged: stagedOf(e),
      ...(e.oldPath ? { oldPath: e.oldPath } : {}),
      additions: add,
      deletions: del,
      binary,
      tooBig,
      changedAt: changedAtOf(abs, status === "deleted"),
      ignored: ignored.has(e.path),
      outside: scope ? !inScope(abs, scope) : false,
    } satisfies ChangeRow;
  });
}

/**
 * Files git ignores that are nonetheless in the list.
 *
 * Only force-added tracked files can be both, so this is usually empty — but it
 * is one spawn to know, and the alternative (what the old endpoint did) was to
 * assert `ignored: false` on every row, which made the "+N ignored" chip lie by
 * omission and put build output in front of the reader with no way to fold it.
 */
async function ignoredSet(root: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  /* `--no-index` is the whole point: without it, check-ignore answers nothing
     for a TRACKED path, and a tracked path matching .gitignore is exactly the
     case worth flagging — a file that was force-added. Paths go as arguments
     rather than on stdin because gitAsync spawns without one. */
  const r = await gitAsync(root, ["check-ignore", "--no-index", "-z", "--", ...paths.slice(0, 500)]);
  // Exit 1 means "none of them", which is the ordinary answer and not an error.
  if (!r.stdout) return new Set();
  return new Set(r.stdout.split("\0").filter(Boolean));
}

/**
 * The last piece of work committed in a checkout, and what it touched.
 *
 * The last NON-merge commit, deliberately: a "merge trunk into branch" is one
 * commit touching every file the merge brought — none of it yours, and hundreds
 * of files of it.
 */
async function committedRows(repo: GitRepoRef, scope: string | null): Promise<ChangeRow[]> {
  const root = repo.root;
  const head = (await gitAsync(root, ["rev-list", "--no-merges", "--max-count=1", "HEAD"])).stdout.trim();
  if (!head) return [];
  const [meta, parent] = await Promise.all([
    gitAsync(root, ["log", "-1", "--format=%H%x00%s%x00%an%x00%ct", head]),
    gitAsync(root, ["rev-parse", "--verify", "--quiet", `${head}^`]),
  ]);
  const [hash = head, subject = "", author = "", ct = "0"] = meta.stdout.trim().split("\0");
  const commit = { hash, subject, author, at: (Number(ct) || 0) * 1000 };
  const from = parent.stdout.trim() ? `${head}^` : EMPTY_TREE;

  const [numstat, names] = await Promise.all([
    gitAsync(root, ["-c", "core.quotePath=false", "diff", "--numstat", "-z", from, head]),
    gitAsync(root, ["-c", "core.quotePath=false", "diff", "--name-status", "-z", from, head]),
  ]);
  const counts = parseNumstat(numstat.stdout);
  const kinds = parseNameStatus(names.stdout);

  const rows: ChangeRow[] = [];
  for (const [path, c] of counts) {
    const k = kinds.get(path);
    rows.push({
      key: `${root}\0${path}`,
      repoRoot: root,
      branch: repo.branch || "",
      path,
      status: k?.status ?? "modified",
      staged: "full",
      ...(k?.oldPath ? { oldPath: k.oldPath } : {}),
      additions: c.add,
      deletions: c.del,
      binary: c.binary,
      tooBig: false,
      // The commit's own date. Every row of one commit shares it, which is
      // correct and is also why they can be grouped under it.
      changedAt: commit.at,
      ignored: false,
      outside: scope ? !inScope(resolve(root, path), scope) : false,
      commit,
    });
  }
  return rows;
}

/** `--name-status -z`: a letter, then the path — and for renames a letter with a
 *  score followed by TWO paths. Same shifting hazard as numstat. */
export function parseNameStatus(out: string): Map<string, { status: ChangeRow["status"]; oldPath?: string }> {
  const map = new Map<string, { status: ChangeRow["status"]; oldPath?: string }>();
  const parts = out.split("\0").filter((s) => s !== "");
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i]!;
    const letter = code[0];
    if (letter === "R" || letter === "C") {
      const oldPath = parts[++i] ?? "";
      const path = parts[++i] ?? "";
      if (path) map.set(path, { status: "renamed", oldPath });
      continue;
    }
    const path = parts[++i] ?? "";
    if (!path) continue;
    map.set(path, {
      status: letter === "A" ? "added" : letter === "D" ? "deleted" : letter === "T" ? "typechange" : "modified",
    });
  }
  return map;
}

/* ── the list ─────────────────────────────────────────────────────────────── */

/**
 * Every in-scope checkout's changes, as rows.
 *
 * Deliberately NOT filtered by branch name. The old endpoint dropped any repo on
 * `main` or `master` on the grounds that trunk is the base you cut from rather
 * than something you work on — which is true of a *branch-vs-base* diff and
 * false of this one: uncommitted work in a trunk checkout is still your work,
 * and a project whose only checkout is trunk showed a permanently empty view.
 */
export async function changeRows(
  repos: GitRepoRef[],
  mode: Mode,
  scope: string | null,
  max = 2000,
): Promise<ChangeRowsResult> {
  const failed: string[] = [];
  const per = await Promise.all(repos.map(async (r) => {
    try {
      return mode === "committed" ? await committedRows(r, scope) : await workingRows(r, scope);
    } catch {
      // One unreadable checkout must not empty the list for the others — it is
      // named instead, which is also how a repo mid-rebase stops being a mystery.
      failed.push(r.root);
      return [] as ChangeRow[];
    }
  }));
  const all = per.flat();
  /* Newest first, and stated here rather than left to the order git happened to
     answer in. This is the first version of this view where that sort means
     anything: every row used to carry the time of the request. */
  all.sort((a, b) => b.changedAt - a.changedAt);
  const rows = all.length > max ? all.slice(0, max) : all;
  return { rows, truncated: all.length - rows.length, ...(failed.length ? { failed } : {}) };
}

/* ── one file's diff ──────────────────────────────────────────────────────── */

/** Parse unified diff text into hunks. Only ever one file's worth. */
export function parseHunks(text: string): { hunks: DiffHunk[]; truncated: boolean } {
  const hunks: DiffHunk[] = [];
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  let count = 0, truncated = false;
  let cur: DiffHunk | null = null;
  for (const l of lines) {
    if (l.startsWith("@@")) {
      const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) { cur = null; continue; }
      cur = { oldStart: +m[1]!, oldLines: m[2] ? +m[2]! : 1, newStart: +m[3]!, newLines: m[4] ? +m[4]! : 1, lines: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("\\")) continue; // "\ No newline at end of file"
    if (count >= DIFF_MAX_LINES) { truncated = true; break; }
    // An empty line in a diff body is a context line whose content is empty; the
    // leading space is what every renderer keys off, so it is put back.
    cur.lines.push(l.length ? l : " ");
    count++;
  }
  return { hunks, truncated };
}

/** A file's identity for caching: content-shaped, never time-of-request. */
function sigOf(root: string, path: string, mode: Mode, commit: string): string {
  if (mode === "committed") return commit;
  try {
    const s = statSync(resolve(root, path));
    return `${Math.round(s.mtimeMs)}:${s.size}`;
  } catch { return "gone"; }
}

/**
 * The diff of one file, which is the only diff anybody is reading.
 *
 * Working mode diffs against HEAD rather than running the staged and unstaged
 * diffs separately: what the reader wants is "how does this file differ from the
 * last commit", and splitting that in two is a staging question, which the Git
 * panel is for.
 */
export async function fileDiff(rootIn: string, path: string, mode: Mode): Promise<FileDiff> {
  const root = rootIn;
  const key = `${root}\0${path}`;
  const abs = resolve(root, path);
  // The path came off the wire. It has to stay inside the repo it claims to be
  // in, or this is a file-read primitive for anything on the disk.
  if (abs !== root && !abs.startsWith(root + sep)) {
    return { key, sig: "", hunks: [], truncated: false, binary: false, error: "path outside the repository" };
  }

  if (mode === "committed") {
    const head = (await gitAsync(root, ["rev-list", "--no-merges", "--max-count=1", "HEAD"])).stdout.trim();
    if (!head) return { key, sig: "", hunks: [], truncated: false, binary: false, error: "no commits" };
    const parent = await gitAsync(root, ["rev-parse", "--verify", "--quiet", `${head}^`]);
    const from = parent.stdout.trim() ? `${head}^` : EMPTY_TREE;
    const r = await gitAsync(root, ["-c", "core.quotePath=false", "diff", from, head, "--", path]);
    return finish(key, sigOf(root, path, mode, head), r.stdout, r.code, r.stderr);
  }

  // Untracked: git has nothing to diff against, so the file IS the diff.
  const tracked = await gitAsync(root, ["ls-files", "--error-unmatch", "-z", "--", path]);
  if (tracked.code !== 0) {
    const u = untrackedDiff(abs);
    return { key, sig: sigOf(root, path, mode, ""), ...u };
  }
  const r = await gitAsync(root, ["-c", "core.quotePath=false", "diff", "HEAD", "--", path]);
  return finish(key, sigOf(root, path, mode, ""), r.stdout, r.code, r.stderr);
}

function finish(key: string, sig: string, out: string, code: number, err: string): FileDiff {
  if (code !== 0) return { key, sig, hunks: [], truncated: false, binary: false, error: err.trim() || "git diff failed" };
  if (/^Binary files /m.test(out)) return { key, sig, hunks: [], truncated: false, binary: true };
  const { hunks, truncated } = parseHunks(out);
  return { key, sig, hunks, truncated, binary: false };
}

/** An untracked file rendered as what it is: every line, added. */
function untrackedDiff(abs: string): Omit<FileDiff, "key" | "sig"> {
  let text: string;
  try {
    if (statSync(abs).size > UNTRACKED_COUNT_MAX * 8) {
      return { hunks: [], truncated: true, binary: false };
    }
    text = readFileSync(abs, "utf8");
  } catch {
    return { hunks: [], truncated: false, binary: true };
  }
  if (text.includes("\0")) return { hunks: [], truncated: false, binary: true };
  const arr = text.split("\n");
  if (arr.length && arr[arr.length - 1] === "") arr.pop();
  const truncated = arr.length > DIFF_MAX_LINES;
  const lines = (truncated ? arr.slice(0, DIFF_MAX_LINES) : arr).map((l) => "+" + l);
  return {
    hunks: lines.length ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: lines.length, lines }] : [],
    truncated,
    binary: false,
  };
}
