/*
 * The `suggestion` blocks inside a review comment.
 *
 * GitHub's suggestion is a fenced block with the word `suggestion` on the
 * fence, and its meaning is positional rather than textual: the block replaces
 * the lines the THREAD is anchored to, not lines named anywhere in the block.
 * So a parser's whole job is to hand back the replacement text; the range comes
 * from `PrThread.startLine`/`line` and from nowhere else.
 *
 * ── why this is shared and not written into a screen ─────────────────────
 * `server/src/prs.ts` already owns the half that writes the commit —
 * `applySuggestion` splices and calls `createCommitOnBranch`. What it does NOT
 * do is find the suggestion in the first place: the desk reads the block out of
 * the comment body it is drawing and posts the text. That reading is the part
 * that can be wrong quietly — an empty block that means "delete these lines" is
 * indistinguishable from "no suggestion here" if you get it wrong, and the
 * difference is somebody's code.
 *
 * ── the empty block is real, and it is the interesting case ──────────────
 * ```suggestion
 * ```
 * means "remove those lines", and GitHub applies it. `spliceLines` on the
 * server takes `""` and produces exactly that. So the parser answers with an
 * ARRAY of blocks and never with `""` meaning absent — a caller that treats
 * falsiness as "none" would silently drop a deletion.
 */

/** One suggested replacement, in the order the blocks appear in the body. */
export interface Suggestion {
  /** The replacement text, newline-joined, with no trailing newline. Empty
   *  string is a real value: it means "delete the lines this thread covers". */
  text: string;
}

/*
 * Fences are matched at any indent, because a suggestion nested inside a list
 * item is indented and is still a suggestion. The closing fence must be at
 * least as long as the opening one, which is CommonMark's own rule and the
 * reason a suggestion CONTAINING a fenced block can be written at all:
 *
 *   ````suggestion
 *   ```
 *   still inside the suggestion
 *   ```
 *   ````
 */
const OPEN = /^(\s*)(`{3,})suggestion\s*$/;

export function suggestionsIn(body: string): Suggestion[] {
  const lines = (body ?? "").split("\n");
  const out: Suggestion[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = OPEN.exec(lines[i] ?? "");
    if (!open) continue;
    const indent = (open[1] ?? "").length;
    const fence = (open[2] ?? "```").length;
    const held: string[] = [];
    let closed = false;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] ?? "";
      const close = /^(\s*)(`{3,})\s*$/.exec(line);
      if (close && (close[2] ?? "").length >= fence) { i = j; closed = true; break; }
      /* The fence's own indent comes off every line, and only that much. A
         suggestion written inside a list item is indented as a whole, and
         keeping that indent would commit it into the file. Removing MORE than
         the fence's indent would eat the code's own nesting, which is why this
         is a slice and not a `trimStart`. */
      held.push(line.slice(0, indent).trim() === "" ? line.slice(indent) : line);
    }
    /* An unclosed fence is dropped rather than guessed at. It happens when
       somebody's comment was truncated, and applying the rest of the message
       as code is the worst available reading of it. */
    if (closed) out.push({ text: held.join("\n") });
  }
  return out;
}

/**
 * The range a thread's suggestion replaces, as `applySuggestion` wants it.
 *
 * Its own function because the fallbacks are the whole content: a thread on one
 * line has no `startLine`, and an OUTDATED thread has no `line` at all — the
 * code it was written about is gone, so there is nothing to replace and the
 * answer is null rather than a guess at `originalLine`. Committing a suggestion
 * onto the line that number now points at would edit code nobody was talking
 * about.
 */
export function suggestionRange(thread: {
  line: number | null;
  startLine?: number | null;
  isOutdated?: boolean;
}): { startLine: number; line: number } | null {
  if (thread.isOutdated) return null;
  const end = thread.line;
  if (!Number.isInteger(end) || (end as number) <= 0) return null;
  const start = Number.isInteger(thread.startLine) && (thread.startLine as number) > 0
    ? (thread.startLine as number)
    : (end as number);
  if (start > (end as number)) return null;
  return { startLine: start, line: end as number };
}
