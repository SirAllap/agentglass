/*
 * Reading a commit on a phone, decided without a screen.
 *
 * The Log used to be a list of dead rows, and the only diff anywhere was one
 * working-tree file. The server already answers the rest (`/git/commit-diff`
 * returns every file a commit changed, with hunks), so this is the arithmetic
 * between that answer and what a thumb needs: which rows a commit has, which
 * file is next, which commits have not left the machine, and whether a branch
 * can be pushed at all.
 *
 * Not here: a commit's body and parent count. `/git/log` does not carry them,
 * and asking a second route per row is the next thing after this.
 */
import type { DiffHunk, GitBranch, GitCommit, GitFileChange } from "../../../shared/types.ts";
import type { DiffFile, DiffLine } from "./diffLines.ts";

/** One file of a commit, as the files list and the jump sheet draw it. */
export interface CommitFile {
  /** Repo-relative, with forward slashes. The key everything else matches on. */
  path: string;
  status: GitFileChange["status"];
  added: number;
  removed: number;
  binary: boolean;
}

/** `/repo/src/a.ts` under `/repo` is `src/a.ts`; anything else is left as given. */
export function relPath(root: string, abs: string): string {
  const base = root.replace(/\/+$/, "");
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : abs;
}

export function commitFiles(root: string, changes: readonly GitFileChange[]): CommitFile[] {
  return changes.map((c) => {
    return { path: relPath(root, c.file_path), status: c.status, added: c.additions, removed: c.deletions, binary: c.binary };
  });
}

export function commitTotals(files: readonly CommitFile[]): { added: number; removed: number } {
  return files.reduce((t, f) => ({ added: t.added + f.added, removed: t.removed + f.removed }), { added: 0, removed: 0 });
}

/** The server's hunks in the shape the pull request diff already draws (and
 *  expands) — so the two screens share one set of gap arithmetic. */
export function diffFileOf(
  path: string, hunks: readonly DiffHunk[], binary: boolean,
  status: GitFileChange["status"] = "modified", from: string | null = null,
): DiffFile {
  let additions = 0, deletions = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") additions++; else if (l[0] === "-") deletions++; }
  return {
    path, from, binary, additions, deletions,
    hunks: hunks.map((h) => ({ header: hunkHeader(h), lines: hunkLines(h) })),
    status: status === "added" || status === "untracked" ? "added"
      : status === "deleted" ? "deleted" : status === "renamed" ? "renamed" : "modified",
  };
}

export function toDiffFile(root: string, change: GitFileChange): DiffFile {
  return diffFileOf(
    relPath(root, change.file_path), change.hunks, change.binary, change.status,
    change.oldPath ? relPath(root, change.oldPath) : null,
  );
}

function hunkHeader(h: DiffHunk): string {
  return `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`;
}

function hunkLines(h: DiffHunk): DiffLine[] {
  let o = h.oldStart, n = h.newStart;
  return h.lines.map((line) => {
    const text = line.slice(1);
    if (line[0] === "+") return { kind: "add", text, oldNo: null, newNo: n++ };
    if (line[0] === "-") return { kind: "del", text, oldNo: o++, newNo: null };
    return { kind: "ctx", text, oldNo: o++, newNo: n++ };
  });
}

/**
 * The offset between the two number columns just above hunk `before` (or just
 * below the last hunk when `before` is the hunk count): context lines are the
 * same line in both files, so old = new + offset. Without it the lines an
 * expander fetches would carry a single number and the reader could not tell
 * which side of the diff they were reading.
 */
export function gapOffset(hunks: readonly DiffHunk[], before: number): number {
  const h = before >= hunks.length ? hunks[hunks.length - 1] : hunks[before];
  if (!h) return 0;
  return before >= hunks.length
    ? (h.oldStart + h.oldLines) - (h.newStart + h.newLines)
    : h.oldStart - h.newStart;
}

/** Where a file sits among the commit's files, and where ‹ and › go. */
export function fileNav(paths: readonly string[], current: string): {
  index: number; label: string; prev: string | null; next: string | null;
} {
  const index = paths.indexOf(current);
  const total = paths.length;
  if (index < 0) return { index: -1, label: "", prev: null, next: null };
  return {
    index, label: `${index + 1} of ${total}`,
    prev: index > 0 ? paths[index - 1] ?? null : null,
    next: index < total - 1 ? paths[index + 1] ?? null : null,
  };
}

/** "1 of 2 viewed" — counted over the files the commit has, so a tick left
 *  over from a path that is no longer in it does not inflate the number. */
export function viewedLabel(paths: readonly string[], viewed: ReadonlySet<string>): string {
  const n = paths.filter((p) => viewed.has(p)).length;
  return `${n} of ${paths.length} viewed`;
}

export function toggled(set: ReadonlySet<string>, path: string): Set<string> {
  const next = new Set(set);
  if (next.has(path)) next.delete(path); else next.add(path);
  return next;
}

/** The pixel width a line needs when it does not wrap: the two number columns,
 *  the sign, and the longest line at the monospace advance. Measured rather than
 *  asked of the layout, because a list windows its rows and cannot. */
export const CHAR_W = 7.3;
export const GUTTER_W = 34 + 34 + 16;
export function unwrappedWidth(file: Pick<DiffFile, "hunks"> | null, min: number): number {
  let longest = 0;
  for (const h of file?.hunks ?? []) for (const l of h.lines) longest = Math.max(longest, l.text.length);
  return Math.max(min, Math.ceil(GUTTER_W + longest * CHAR_W + 16));
}

/** One decoration `git log` put on a commit. */
export interface RefChip { label: string; kind: "head" | "local" | "remote" | "tag" }

/** `HEAD -> feat/x, origin/feat/x, tag: v1` as chips, the checked-out branch
 *  first: it is the one that says where you are in a log of identical lines. */
export function parseRefs(refs: string): RefChip[] {
  const out: RefChip[] = [];
  for (const raw of refs.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith("HEAD -> ")) out.unshift({ label: raw.slice(8), kind: "head" });
    else if (raw === "HEAD") out.push({ label: "HEAD", kind: "head" });
    else if (raw.startsWith("tag: ")) out.push({ label: raw.slice(5), kind: "tag" });
    else if (raw.endsWith("/HEAD")) continue;
    else out.push({ label: raw, kind: isRemoteRef(raw) ? "remote" : "local" });
  }
  return out;
}

/** A decoration that names a remote branch. Only origin: git's own default and
 *  the one `/git/push` pushes to unless the branch says otherwise. */
function isRemoteRef(label: string): boolean {
  return label.startsWith("origin/");
}

/**
 * The commits at the top of the log that no remote has — the ones a push
 * would send. A commit is on a remote when it carries an `origin/…`
 * decoration, and so is everything below it, so the first such commit ends the
 * run. `null` when the page never reached one: forty unpushed commits and a log
 * that stopped short look the same, and a count made up from the page length
 * would be a number nobody measured.
 */
export function unpushedHashes(commits: readonly GitCommit[]): Set<string> | null {
  const out = new Set<string>();
  for (const c of commits) {
    if (parseRefs(c.refs).some((r) => r.kind === "remote")) return out;
    out.add(c.hash);
  }
  return commits.length === 0 ? out : null;
}

/** What Push can do, and what to call it. */
export interface PushState {
  /** The branch has an upstream to push to. False for a branch never pushed. */
  upstream: string | null;
  /** Commits a push would send; null when it cannot be counted (see above). */
  ahead: number | null;
  canPush: boolean;
  /** "Push 2", "Push", or "Push" with nothing to send. */
  label: string;
  /** The one-line chip beside the branch: "2 to push", "not pushed", or none. */
  chip: string | null;
}

/**
 * `ahead` alone cannot say this: a branch with no upstream reads 0 ahead, and
 * "0 ahead" disabled the one button that publishes it. So the branch row says
 * whether there is an upstream, and with none the count comes from the log.
 *
 * `current` is the checked-out branch from `/git/branches`; `commits` the log
 * from HEAD, which is only needed — and only asked for — without an upstream.
 */
export function pushState(current: GitBranch | null, commits: readonly GitCommit[] | null): PushState {
  if (!current) return { upstream: null, ahead: 0, canPush: false, label: "Push", chip: null };
  const gone = /gone/.test(current.track);
  if (current.upstream && !gone) {
    const n = Number(/ahead (\d+)/.exec(current.track)?.[1]) || 0;
    return { upstream: current.upstream, ahead: n, canPush: n > 0, label: n ? `Push ${n}` : "Push", chip: n ? `${n} to push` : null };
  }
  if (commits === null) return { upstream: null, ahead: null, canPush: false, label: "Push", chip: null };
  if (commits.length === 0) return { upstream: null, ahead: 0, canPush: false, label: "Push", chip: null };
  const n = unpushedHashes(commits)?.size ?? null;
  if (n === 0) return { upstream: null, ahead: 0, canPush: false, label: "Push", chip: null };
  return {
    upstream: null, ahead: n, canPush: true,
    label: n === null ? "Push" : `Push ${n}`,
    chip: n === null ? "not pushed" : `${n} to push`,
  };
}

/** Said before a checkout that would carry uncommitted work along, or null when
 *  there is none to carry. git refuses the switch when a file would be
 *  overwritten, but it happily takes the rest with it — and "it did not stop me"
 *  is not the same as "it was what I meant". */
export function switchWarning(dirty: number | null, target: string): string | null {
  // Not read yet, or the read failed: "no changes" is a guess, and the confirm
  // exists for exactly the tree nobody has looked at.
  if (dirty === null) return `This phone has not read what is changed here, so any uncommitted work comes with you to ${target} unless git finds a clash, and then it stops and says so.`;
  if (dirty <= 0) return null;
  const files = dirty === 1 ? "1 file has" : `${dirty} files have`;
  return `${files} uncommitted changes. They come with you to ${target} unless git finds a clash, and then it stops and says so.`;
}
