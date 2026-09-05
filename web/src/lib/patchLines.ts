/*
 * Which lines a patch touched.
 *
 * A diff knows perfectly well that a file changed at 883, 914, 945 and 974, and
 * then hands you the file with no sign of where any of them are. This reads the
 * hunk headers and the body and answers with those numbers, so a viewer can open
 * at the first one and offer the rest as jumps.
 *
 * The body, not only the headers: `@@ -880,7 +880,7 @@` says a hunk starts at
 * 880, and the line that actually changed inside it is 883. Landing three lines
 * off is the kind of nearly-right that makes people stop trusting the jump.
 */

/** Every line number, in the NEW file, that a unified patch adds or replaces.
 *  Deletions are reported at the line they were removed from — that is where
 *  you have to look to see what happened. */
export function changedLines(patch: string, cap = 200): number[] {
  const out: number[] = [];
  let line = 0;
  let pending = 0;
  for (const raw of patch.split("\n")) {
    if (raw.startsWith("@@")) {
      const m = /@@ -\d+(?:,\d+)? \+(\d+)/.exec(raw);
      line = m ? Number(m[1]) : 0;
      pending = 0;
      continue;
    }
    if (!line) continue;
    if (raw.startsWith("+")) {
      if (out[out.length - 1] !== line) out.push(line);
      line++;
      pending = 0;
    } else if (raw.startsWith("-")) {
      // A deletion has no line of its own in the new file: mark the place it
      // was taken from, once per run, so five deleted lines are one jump.
      if (!pending && out[out.length - 1] !== line) out.push(line);
      pending = 1;
    } else if (raw.startsWith(" ") || raw === "") {
      line++;
      pending = 0;
    }
    if (out.length >= cap) break;
  }
  return out;
}

/** The first changed line, or 1 for a patch with nothing in it. */
export const firstChangedLine = (patch: string): number => changedLines(patch, 1)[0] ?? 1;

/**
 * One file's patch, out of a whole `git diff`.
 *
 * The pull-request panel holds the diff for every file as one string, so a
 * viewer asking "where did THIS file change" has to find its section first. The
 * `+++ b/<path>` line is the honest anchor: `diff --git` quotes paths with
 * spaces in them and a rename has two of them, while `+++` always names the
 * file as it is now.
 */
export function fileSection(diff: string, path: string): string {
  const lines = diff.split("\n");
  let from = -1;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (from < 0) {
      if (l.startsWith("+++ ") && (l.slice(4) === `b/${path}` || l.slice(4) === path)) from = i + 1;
      continue;
    }
    // The next file starts here, so this one ended on the line before.
    if (l.startsWith("diff --git ")) return lines.slice(from, i).join("\n");
  }
  return from < 0 ? "" : lines.slice(from).join("\n");
}

/** The changed lines of one file inside a whole diff. */
export const linesForFile = (diff: string, path: string): number[] => changedLines(fileSection(diff, path));

/**
 * The same answer, from hunks that are already parsed.
 *
 * The pull-request panel holds a diff as text; the other two views hold it as
 * `DiffHunk[]` — same information, and this is the same walk over it, so the
 * jumps in all three agree.
 */
export function linesFromHunks(hunks: { newStart: number; lines: string[] }[], cap = 200): number[] {
  const out: number[] = [];
  for (const h of hunks) {
    let line = h.newStart;
    let pending = 0;
    for (const raw of h.lines) {
      if (raw.startsWith("+")) {
        if (out[out.length - 1] !== line) out.push(line);
        line++;
        pending = 0;
      } else if (raw.startsWith("-")) {
        if (!pending && out[out.length - 1] !== line) out.push(line);
        pending = 1;
      } else {
        line++;
        pending = 0;
      }
      if (out.length >= cap) return out;
    }
  }
  return out;
}
