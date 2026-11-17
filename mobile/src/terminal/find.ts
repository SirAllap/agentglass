/*
 * Searching a pane's scrollback, on the phone.
 *
 * The page can only hand its buffer up as text (terminal-html.ts), so the
 * search is here: one implementation, tested on strings, and the WebView is
 * left with the two things only it can do — move the viewport to a line and
 * paint it.
 *
 * One hit per LINE, because a line is the jump target: a line that says `rail`
 * four times is one place to go, and a count of four would promise three more
 * stops that all land on the same row.
 *
 * Case-insensitive and a plain substring, which is what is being asked for
 * ("where did it print rail") — not a regex, where every `[` in a log is a
 * query that throws.
 */

export interface Hit {
  /** 0-based index into the scrollback the page handed up. */
  line: number;
  /** The line as it was found, so the sheet can show what it matched. */
  text: string;
}

/** Every line that contains `query`, oldest first. An empty query matches
 *  nothing — that is the "show me the buffer again" answer, not every line. */
export function find(lines: readonly string[], query: string): Hit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: Hit[] = [];
  lines.forEach((text, line) => {
    if (text.toLowerCase().includes(needle)) hits.push({ line, text });
  });
  return hits;
}

/**
 * "11 lines · 3 matches", the line under the field.
 *
 * Both numbers, because they answer different questions: how much the phone is
 * searching, and how much it found. Said as the mock says it, and in the
 * singular where it is one.
 */
export function countLine(lines: number, hits: number): string {
  const found = hits === 0 ? "no matches" : hits === 1 ? "1 match" : `${hits} matches`;
  return `${lines} ${lines === 1 ? "line" : "lines"} · ${found}`;
}

/** The next hit, wrapping past the last one back to the first.
 *
 *  Wrapping is the whole of what "no more matches" would otherwise cost: the
 *  person pressing next at the bottom of a log wants the top of it. `0` when
 *  there is nothing to step through. */
export function next(at: number, hits: number): number {
  if (hits <= 0) return 0;
  return at >= hits - 1 || at < 0 ? 0 : at + 1;
}

/** The previous hit, wrapping past the first back to the last. */
export function prev(at: number, hits: number): number {
  if (hits <= 0) return 0;
  return at <= 0 ? hits - 1 : at - 1;
}
