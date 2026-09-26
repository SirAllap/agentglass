/*
 * A working-tree file's diff as rows for a phone-width list.
 *
 * `/git/file-diff` answers with hunks whose lines begin with " ", "+" or "-".
 * This is only the arithmetic a screen needs: a header per hunk, one row per
 * line, and the line numbers a reader quotes — an added line has no old
 * number and a removed one no new number. The pull request diff has its own
 * parser (diffLines.ts) for `gh pr diff` text; this one takes the server's
 * already-parsed hunks, so it does not go through it.
 */
import type { DiffHunk } from "../../../shared/types.ts";

export interface GitDiffRow {
  key: string;
  kind: "hunk" | "ctx" | "add" | "del";
  text: string;
  old?: number;
  new?: number;
}

export function gitDiffRows(hunks: readonly DiffHunk[]): GitDiffRow[] {
  const rows: GitDiffRow[] = [];
  hunks.forEach((h, hi) => {
    rows.push({ key: `h${hi}`, kind: "hunk", text: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
    let o = h.oldStart, n = h.newStart;
    h.lines.forEach((line, li) => {
      const sign = line[0];
      const text = line.slice(1);
      const key = `h${hi}l${li}`;
      if (sign === "+") rows.push({ key, kind: "add", text, new: n++ });
      else if (sign === "-") rows.push({ key, kind: "del", text, old: o++ });
      else rows.push({ key, kind: "ctx", text, old: o++, new: n++ });
    });
  });
  return rows;
}

export function gitDiffTotals(hunks: readonly DiffHunk[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const h of hunks) for (const l of h.lines) { if (l[0] === "+") added++; else if (l[0] === "-") removed++; }
  return { added, removed };
}
