// Finding a word across every file in a review.
//
// The browser's own Ctrl+F cannot do this here and never could: files are
// folded once marked viewed, the diff is windowed, and half the matches are in
// nodes that do not exist yet. So a review of thirteen files had no way to
// answer "where else does this helper get called?" without opening each one and
// searching it separately — which is the question you ask most while reviewing.
import type { FileChange, DiffHunk } from "../../../shared/types.ts";

export type Match = {
  path: string;
  /** The line as the diff shows it, with its leading marker removed. */
  text: string;
  /** Which side the line belongs to, and its number there. A context line
   *  exists on both; it is reported on the new side, which is what the reader
   *  is looking at. */
  side: "LEFT" | "RIGHT";
  line: number;
  /** Where the hit starts in `text`, and how long it is. The length travels
   *  with the match rather than being re-derived from the query later: an
   *  excerpt that guesses it highlights to the end of the line. */
  at: number;
  len: number;
};

/** Files come back in the order they were given, and matches within a file in
 *  the order they appear in it — so "next match" walks the review the way you
 *  would read it. */
export function findInDiffs(files: { path: string; change: FileChange | undefined }[], query: string, limit = 500): Match[] {
  const q = query.trim().toLowerCase();
  if (q.length < 2) return [];
  const out: Match[] = [];
  for (const { path, change } of files) {
    if (!change) continue;
    for (const h of change.hunks) {
      for (const m of hunkMatches(h, q)) {
        out.push({ path, ...m });
        // Bounded: a one-letter-ish query on a large review can match tens of
        // thousands of lines, and a list nobody can walk is not an answer.
        if (out.length >= limit) return out;
      }
    }
  }
  return out;
}

function* hunkMatches(h: DiffHunk, q: string): Generator<Omit<Match, "path">> {
  let oldN = h.oldStart, newN = h.newStart;
  for (const raw of h.lines) {
    // "\" is git's "no newline at end of file" marker — not a line of the file.
    if (raw.startsWith("\\")) continue;
    const tag = raw[0];
    const text = raw.slice(1);
    const at = text.toLowerCase().indexOf(q);
    if (at >= 0) {
      // A removed line only exists on the left; everything else is reported
      // where the reader will find it, on the right.
      if (tag === "-") yield { text, side: "LEFT", line: oldN, at, len: q.length };
      else yield { text, side: "RIGHT", line: newN, at, len: q.length };
    }
    if (tag === "+") newN++;
    else if (tag === "-") oldN++;
    else { oldN++; newN++; }
  }
}

/** Matches grouped by file, in file order, for a list that reads as "three in
 *  models.py, one in calls.py" rather than as forty undifferentiated rows. */
export function groupByFile(matches: Match[]): { path: string; matches: Match[] }[] {
  const out: { path: string; matches: Match[] }[] = [];
  for (const m of matches) {
    const last = out[out.length - 1];
    if (last && last.path === m.path) last.matches.push(m);
    else out.push({ path: m.path, matches: [m] });
  }
  return out;
}

/** The line, split around the hit, so it can be drawn with the match picked out
 *  without the caller doing index arithmetic. Trimmed from the left when the
 *  hit is far along a very long line, so the interesting part is on screen. */
export function excerpt(m: Match, width = 120): { before: string; hit: string; after: string } {
  const start = Math.max(0, m.at - Math.floor(width / 3));
  const text = m.text.slice(start, start + width);
  const at = m.at - start;
  const len = Math.max(0, Math.min(m.len, text.length - at));
  return {
    before: (start > 0 ? "…" : "") + text.slice(0, at),
    hit: text.slice(at, at + len),
    after: text.slice(at + len),
  };
}
