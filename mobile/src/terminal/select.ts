/*
 * Selecting lines of a pane and copying them as plain text.
 *
 * The mock's select mode is: tap lines, a bar counts them, Copy writes them and
 * says so. The taps arrive as buffer indices from the page (terminal-html.ts
 * turns a finger into a line), so what is left is a set of integers and the
 * text they name — which is the half worth testing, because "the copied text is
 * the selection" is the whole promise of the feature.
 *
 * A SET and not a range: two lines from the middle of an error and the command
 * that produced them is the ordinary use, and a range forces the lines between
 * them along for the ride.
 */

/** Toggle one line in or out, kept in buffer order.
 *
 *  Order matters at copy time — the clipboard should read like the screen — and
 *  it is kept here rather than sorted on the way out so the bar's own reading
 *  and the copied text can never disagree. */
export function toggle(picked: readonly number[], line: number): number[] {
  if (!Number.isInteger(line) || line < 0) return [...picked];
  const next = picked.includes(line) ? picked.filter((n) => n !== line) : [...picked, line];
  return next.sort((a, b) => a - b);
}

/** "2 lines selected", the bar's left-hand reading. */
export function countLine(picked: readonly number[]): string {
  return countWords(picked.length);
}

/** The same words for a count already known — the bar holds a number, not the
 *  list, and two spellings of one sentence is how they drift apart. */
export function countWords(n: number): string {
  return n === 0 ? "No lines selected" : n === 1 ? "1 line selected" : `${n} lines selected`;
}

/**
 * The lines that were picked, as one plain-text block.
 *
 * Trailing blanks go, because a terminal pads every row to the pane's width and
 * a clipboard carrying sixty spaces of padding is a clipboard that looks broken
 * after a paste. Nothing else is touched: leading indentation is the code, and
 * a blank line inside the selection was picked on purpose.
 */
export function copied(lines: readonly string[], picked: readonly number[]): string {
  return picked
    .map((n) => lines[n])
    .filter((text): text is string => typeof text === "string")
    .map((text) => text.replace(/\s+$/, ""))
    .join("\n");
}

/** The confirmation the bar shows after Copy. Says the count, and never claims
 *  something was copied when nothing was. */
export function copyLine(picked: readonly number[]): string {
  const n = picked.length;
  return n === 0 ? "Nothing to copy" : n === 1 ? "1 line copied" : `${n} lines copied`;
}
