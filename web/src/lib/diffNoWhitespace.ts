// "Show me what changed, not how it was indented."
//
// A formatting pass — a prettier run, a re-indent, a tab-to-spaces sweep — arrives as
// a diff where every line of a file is deleted and added back. There is usually one
// real change hiding in it, and reading a review like that means reading the whole
// file twice. GitHub has a button for this (`?w=1`) and git has a flag (`-w`); the
// panel had neither, because the patch it draws comes from GitHub already made.
//
// So it is done on the parsed diff, which is honest work rather than a trick: a
// deletion and an addition whose text differs only in whitespace are the same line,
// and drawing them as one context line is what "ignore whitespace" means. Nothing is
// hidden that a reader could not verify — the toggle is a toggle, and a file that
// turns out to hold NOTHING but whitespace changes is named rather than silently
// emptied.

import type { ParsedFile } from "./prBody.ts";

/**
 * Any hunk, from either of the two shapes this app has.
 *
 * The pull request panel parses GitHub's patch into `ParsedHunk`; the Diff view is
 * handed `DiffHunk` by the server. They are the same four numbers and the same array
 * of lines, and this function has no business knowing which one it was given —
 * structural, so both surfaces get the same behaviour from the same tested code.
 */
export interface HunkLike {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** Whitespace-blind comparison: every run of blanks, tabs included, taken out. Not
 *  "trimmed", which would call `a  b` and `a b` different. */
const bare = (s: string): string => s.replace(/\s+/g, "");

/** A line's job in a hunk. `\` is git's "No newline at end of file" marker, which is
 *  neither a change nor context and must survive untouched. */
const kindOf = (l: string): "add" | "del" | "ctx" | "note" =>
  l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : l.startsWith("\\") ? "note" : "ctx";

/**
 * One hunk with its whitespace-only changes folded into context.
 *
 * A diff writes a replacement as a run of deletions followed by a run of additions,
 * so the pairing is positional within such a run — first deletion with first
 * addition, and so on. Anything left over when the runs are different lengths is a
 * real change and stays exactly as it was.
 */
export function hunkWithoutWhitespace<T extends HunkLike>(h: T): T {
  const out: string[] = [];
  let i = 0;
  while (i < h.lines.length) {
    if (kindOf(h.lines[i]!) !== "del") { out.push(h.lines[i]!); i++; continue; }
    const dels: string[] = [];
    while (i < h.lines.length && kindOf(h.lines[i]!) === "del") { dels.push(h.lines[i]!); i++; }
    const adds: string[] = [];
    let j = i;
    while (j < h.lines.length && kindOf(h.lines[j]!) === "add") { adds.push(h.lines[j]!); j++; }
    const pairs = Math.min(dels.length, adds.length);
    let folded = 0;
    for (let k = 0; k < pairs; k++) {
      if (bare(dels[k]!.slice(1)) !== bare(adds[k]!.slice(1))) break;
      folded++;
    }
    /* Only a LEADING run of pairs is folded. Stopping at the first real difference
       keeps the two runs aligned: fold a matching pair from the middle and every
       pairing after it is off by one, which turns a real change into a wrong one. */
    for (let k = 0; k < folded; k++) out.push(` ${adds[k]!.slice(1)}`);
    for (let k = folded; k < dels.length; k++) out.push(dels[k]!);
    for (let k = folded; k < adds.length; k++) out.push(adds[k]!);
    i = j;
  }
  const oldLines = out.filter((l) => kindOf(l) === "ctx" || kindOf(l) === "del").length;
  const newLines = out.filter((l) => kindOf(l) === "ctx" || kindOf(l) === "add").length;
  return { ...h, lines: out, oldLines, newLines };
}

/** Does this hunk still say anything? A hunk of pure context is a hunk whose whole
 *  content was whitespace, and drawing it is drawing an unchanged file. */
export const hunkChanges = (h: HunkLike): boolean => h.lines.some((l) => kindOf(l) === "add" || kindOf(l) === "del");

/**
 * The whole diff, whitespace-blind.
 *
 * `onlyWhitespace` is the list of files that lost everything: they are dropped from
 * the diff — that is the point — and NAMED, because a file that vanishes from a
 * review with no explanation is the reader wondering what else went missing.
 */
export function withoutWhitespace(files: ParsedFile[]): { files: ParsedFile[]; onlyWhitespace: string[] } {
  const kept: ParsedFile[] = [];
  const onlyWhitespace: string[] = [];
  for (const f of files) {
    // A binary file parses to zero hunks (see diffKind) and has no whitespace to
    // ignore. Untouched, and never counted as "only whitespace".
    if (!f.hunks.length) { kept.push(f); continue; }
    const hunks = f.hunks.map(hunkWithoutWhitespace).filter(hunkChanges);
    if (!hunks.length) { onlyWhitespace.push(f.path); continue; }
    const additions = hunks.reduce((n, h) => n + h.lines.filter((l) => kindOf(l) === "add").length, 0);
    const deletions = hunks.reduce((n, h) => n + h.lines.filter((l) => kindOf(l) === "del").length, 0);
    kept.push({ ...f, hunks, additions, deletions });
  }
  return { files: kept, onlyWhitespace };
}
