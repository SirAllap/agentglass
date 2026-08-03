// When a message is too long to sit in a conversation uncollapsed.
//
// The case this exists for is a pasted prompt: a review brief with its rules,
// its context and a block of JSON is two hundred lines, and rendered whole it
// fills the panel and pushes the actual conversation off the screen. The reply
// you came to read is somewhere below the fold of something you wrote yourself.
//
// Decided from the text rather than from a measured height, because measuring
// means rendering it first — laying out two hundred lines to discover they
// should not be laid out. The threshold is deliberately generous: folding a
// message that would have fitted is more annoying than scrolling past one that
// nearly did.

/** Lines beyond which a message gets a fold. Chosen against real prompts: the
 *  ones worth folding run to hundreds of lines, and ordinary chat turns —
 *  including a paragraph with a short code block — stay under this. */
export const FOLD_LINES = 14;

/** ...and the same for a message with few newlines but a lot of prose, which
 *  wraps to just as many rows on screen. */
export const FOLD_CHARS = 1400;

export function isLongMessage(text: string | undefined | null): boolean {
  if (!text) return false;
  if (text.length > FOLD_CHARS) return true;
  // `split` allocates the whole array to count; a message can be 100 KB.
  let lines = 1;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10 && ++lines > FOLD_LINES) return true;
  }
  return false;
}

/**
 * What a folded message shows.
 *
 * The first lines, not a summary: this is somebody's own words and the top of
 * them is the part that says what they are. Trailing blank lines are dropped so
 * the fold does not appear to cut in the middle of nothing.
 */
export function foldPreview(text: string, lines = FOLD_LINES): string {
  const out: string[] = [];
  let start = 0;
  while (out.length < lines && start <= text.length) {
    const nl = text.indexOf("\n", start);
    const end = nl === -1 ? text.length : nl;
    out.push(text.slice(start, end));
    if (nl === -1) break;
    start = nl + 1;
  }
  while (out.length && !out[out.length - 1]!.trim()) out.pop();
  return out.join("\n");
}

/** How much is being hidden, for the control to say so — a fold that does not
 *  say what it costs to open is a fold nobody opens. */
export function hiddenLineCount(text: string, shown = FOLD_LINES): number {
  let lines = 1;
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) lines++;
  return Math.max(0, lines - shown);
}
