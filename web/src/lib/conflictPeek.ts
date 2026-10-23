import type { ConflictFile } from "../../../shared/types.ts";

/**
 * A conflicted file flattened into the rows a read-only preview draws: each
 * conflict region with a couple of lines of the code around it, and a gap row
 * standing in for everything else.
 *
 * Kept out of the component because the rule that matters — two conflicts a
 * few lines apart must not show the same context twice, and a far-off stretch
 * must not be silently dropped — is a decision about rows, not about pixels.
 *
 * Line numbers are the raw ones the server computed (markers counted), the
 * numbers an editor shows for the same file.
 */
export type PeekRow =
  | { kind: "ctx" | "ours" | "theirs" | "base"; n: number; text: string }
  | { kind: "marker"; n: number; text: string }
  | { kind: "gap"; hidden: number };

export function peekRows(file: Pick<ConflictFile, "segments" | "blocks">, ctx = 2): PeekRow[] {
  const rows: PeekRow[] = [];
  const { segments, blocks } = file;
  segments.forEach((seg, i) => {
    if (seg.kind === "text") {
      const afterConflict = segments[i - 1]?.kind === "conflict";
      const beforeConflict = segments[i + 1]?.kind === "conflict";
      const at = (k: number) => ({ kind: "ctx" as const, n: seg.from + k, text: seg.lines[k]! });
      const all = seg.lines.length;
      const head = afterConflict ? Math.min(ctx, all) : 0;
      const tail = beforeConflict ? Math.min(ctx, all - head) : 0;
      for (let k = 0; k < head; k++) rows.push(at(k));
      const hidden = all - head - tail;
      if (hidden > 0) rows.push({ kind: "gap", hidden });
      for (let k = all - tail; k < all; k++) rows.push(at(k));
      return;
    }
    const b = blocks.find((x) => x.index === seg.index);
    if (!b) return;
    let n = b.line;
    rows.push({ kind: "marker", n: n++, text: `<<<<<<< ${b.ourLabel}`.trimEnd() });
    for (const t of b.ours) rows.push({ kind: "ours", n: n++, text: t });
    if (b.base) {
      rows.push({ kind: "marker", n: n++, text: "|||||||" });
      for (const t of b.base) rows.push({ kind: "base", n: n++, text: t });
    }
    rows.push({ kind: "marker", n: n++, text: "=======" });
    for (const t of b.theirs) rows.push({ kind: "theirs", n: n++, text: t });
    rows.push({ kind: "marker", n: n, text: `>>>>>>> ${b.theirLabel}`.trimEnd() });
  });
  return rows;
}
