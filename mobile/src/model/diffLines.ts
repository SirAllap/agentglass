/*
 * A unified diff, turned into rows a phone can draw.
 *
 * `/prs/diff` answers with the whole thing as one string — the output of
 * `gh pr diff` — and a screen cannot render a string. What it needs is per
 * file, per hunk, per line, with the line NUMBERS worked out, because those
 * are what a comment is anchored to and they are not in the text: a unified
 * diff states each hunk's starting line once and expects the reader to count.
 *
 * Pure, and therefore tested. Every rule below is a thing that silently
 * mis-numbers somebody's comment if it is wrong, and a comment posted against
 * the wrong line is worse than no comment — it is a remark about code the
 * author did not write.
 *
 * ── what it does not do ──────────────────────────────────────────────────
 * No syntax highlighting and no word-level intra-line diff. Both are real and
 * both belong to a screen with more room than 393 points; what is here is the
 * structure, which is what the numbering and the navigation need.
 */

export type DiffLineKind = "add" | "del" | "ctx" | "meta";

export interface DiffLine {
  kind: DiffLineKind;
  /** The line WITHOUT its leading +/-/space. The marker is a rendering
   *  decision, and keeping it in the text means every consumer has to strip
   *  it — including a comment body, which would then quote a `+`. */
  text: string;
  /** Line number on the base side, when this line exists there. */
  oldNo: number | null;
  /** Line number on the head side. This is the one a comment anchors to:
   *  GitHub's line comments are against the file as it is now. */
  newNo: number | null;
}

export interface DiffHunk {
  /** The `@@ … @@` line, verbatim, including whatever trailing context gh put
   *  on it — usually the enclosing function, which is the most useful thing on
   *  screen for saying where you are. */
  header: string;
  lines: DiffLine[];
}

export interface DiffFile {
  /** The path as it is NOW. For a deletion, the path it had. */
  path: string;
  /** Where it came from, when the change is a rename. Null otherwise. */
  from: string | null;
  status: "added" | "deleted" | "renamed" | "modified";
  /** Git said the contents are binary, so there are no lines to show. */
  binary: boolean;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** `a/src/x.ts` → `src/x.ts`. Git prefixes both sides and neither prefix is
 *  part of any real path; `/dev/null` is git's word for "this side does not
 *  exist" and must not become a file called `null`. */
function strip(path: string): string {
  if (path === "/dev/null") return "";
  return path.replace(/^[ab]\//, "");
}

/** The four numbers in `@@ -12,7 +12,9 @@`. A hunk with one line omits its
 *  count — `@@ -12 +12 @@` is legal — and defaults to 1. */
function parseHunkHeader(line: string): { oldStart: number; newStart: number } | null {
  const m = /^@@+ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
  if (!m) return null;
  return { oldStart: Number(m[1]), newStart: Number(m[2]) };
}

/**
 * Split the whole diff into files.
 *
 * Driven off `diff --git` rather than off `---`/`+++`, because a rename with
 * no content change has the first and neither of the others — and a file that
 * is only a mode change has just the first. Both are real entries a reader
 * should see rather than rows that vanish.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  const close = (): void => { if (file) files.push(file); };

  for (const raw of (text ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      close();
      hunk = null;
      // `diff --git a/x b/x`. Taken from the LAST two space-separated fields
      // rather than by splitting the whole line: a path with a space in it
      // breaks a naive split, and git does not quote these.
      const parts = raw.slice("diff --git ".length).trim();
      const half = Math.floor(parts.length / 2);
      // The two halves are the same path twice for anything but a rename, so
      // the midpoint is a good guess and the `---`/`+++` lines below correct
      // it whenever they exist.
      const guess = strip(parts.slice(0, half).trim());
      file = {
        path: guess, from: null, status: "modified", binary: false,
        hunks: [], additions: 0, deletions: 0,
      };
      continue;
    }
    if (!file) continue;

    if (raw.startsWith("new file mode")) { file.status = "added"; continue; }
    if (raw.startsWith("deleted file mode")) { file.status = "deleted"; continue; }
    if (raw.startsWith("rename from ")) {
      file.from = raw.slice("rename from ".length).trim();
      file.status = "renamed";
      continue;
    }
    if (raw.startsWith("rename to ")) {
      file.path = raw.slice("rename to ".length).trim();
      continue;
    }
    // "Binary files a/x and b/x differ", and the GIT binary patch header.
    if (raw.startsWith("Binary files ") || raw.startsWith("GIT binary patch")) {
      file.binary = true;
      continue;
    }
    if (raw.startsWith("--- ")) {
      const path = strip(raw.slice(4).trim());
      // Only informative for a rename or a delete; for a plain edit both sides
      // are the same and `+++` sets the authoritative one below.
      if (path && file.status === "renamed" && !file.from) file.from = path;
      continue;
    }
    if (raw.startsWith("+++ ")) {
      const path = strip(raw.slice(4).trim());
      // `/dev/null` on this side means the file was deleted, and then the name
      // to show is the one it had — which `---` carried.
      if (path) file.path = path;
      continue;
    }

    if (raw.startsWith("@@")) {
      const at = parseHunkHeader(raw);
      if (!at) continue;
      oldNo = at.oldStart;
      newNo = at.newStart;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }

    if (!hunk) continue;

    /*
     * The body. Four shapes, and the fourth is the one that bites.
     *
     * A context line is a space followed by the text — but an EMPTY context
     * line is often written as a completely empty string rather than a single
     * space, by git and by everything that reformats a patch. Treating that as
     * "not part of the diff" desynchronises every line number below it, which
     * is the failure this whole module exists to avoid.
     */
    if (raw.startsWith("+")) {
      hunk.lines.push({ kind: "add", text: raw.slice(1), oldNo: null, newNo });
      newNo += 1;
      file.additions += 1;
      continue;
    }
    if (raw.startsWith("-")) {
      hunk.lines.push({ kind: "del", text: raw.slice(1), oldNo, newNo: null });
      oldNo += 1;
      file.deletions += 1;
      continue;
    }
    if (raw.startsWith("\\")) {
      // "\ No newline at end of file". It describes the line above and occupies
      // no line of its own on either side.
      hunk.lines.push({ kind: "meta", text: raw.slice(1).trim(), oldNo: null, newNo: null });
      continue;
    }
    // Context, including the empty-string case.
    hunk.lines.push({ kind: "ctx", text: raw.startsWith(" ") ? raw.slice(1) : raw, oldNo, newNo });
    oldNo += 1;
    newNo += 1;
  }

  close();
  return files;
}

/**
 * Which line a comment on this row would be anchored to.
 *
 * GitHub anchors a review comment to a line of the file as it is NOW, on the
 * RIGHT side. A deleted line has no such number, so it cannot carry one — and
 * offering the box on a row that cannot take a comment is a control that fails
 * after somebody has typed into it.
 */
export function commentableLine(line: DiffLine): number | null {
  if (line.kind === "add" || line.kind === "ctx") return line.newNo;
  return null;
}

/** How the file list should read a parsed entry. Its own function so the
 *  screen and the tests agree on the word. */
export function fileLabel(file: DiffFile): string {
  if (file.status === "renamed" && file.from) return `${file.from} → ${file.path}`;
  return file.path;
}
