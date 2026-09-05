/*
 * What a formatting button does to the text under the cursor.
 *
 * Pure string work, kept away from the textarea: what makes an editor feel
 * right is the small stuff — pressing bold with nothing selected leaves the
 * caret BETWEEN the asterisks so you can type, pressing it again on the same
 * word takes the bold off rather than nesting it, and a list button applied to
 * four selected lines prefixes all four. None of that can be checked by looking
 * at a screenshot, and all of it can be checked here.
 */

export interface Sel {
  text: string;
  /** Selection start and end, as a textarea reports them. */
  start: number;
  end: number;
}

/** The same shape back, with where the caret should end up. */
export type Edit = Sel;

const wrapWith = (mark: string, s: Sel): Edit => {
  const before = s.text.slice(0, s.start);
  const chosen = s.text.slice(s.start, s.end);
  const after = s.text.slice(s.end);

  // Already wrapped, either inside the selection or just outside it: take it
  // off. A second press on a bold word has to undo, not produce ****word****.
  if (chosen.startsWith(mark) && chosen.endsWith(mark) && chosen.length >= mark.length * 2) {
    const bare = chosen.slice(mark.length, -mark.length);
    return { text: before + bare + after, start: s.start, end: s.start + bare.length };
  }
  if (before.endsWith(mark) && after.startsWith(mark)) {
    return {
      text: before.slice(0, -mark.length) + chosen + after.slice(mark.length),
      start: s.start - mark.length,
      end: s.end - mark.length,
    };
  }
  const out = before + mark + chosen + mark + after;
  return chosen
    ? { text: out, start: s.start + mark.length, end: s.end + mark.length }
    // Nothing selected: the caret goes between the marks, ready to type.
    : { text: out, start: s.start + mark.length, end: s.start + mark.length };
};

export const bold = (s: Sel): Edit => wrapWith("**", s);
export const italic = (s: Sel): Edit => wrapWith("*", s);
export const strike = (s: Sel): Edit => wrapWith("~~", s);
export const code = (s: Sel): Edit => wrapWith("`", s);

/** A link. With text selected that text becomes the label and the caret lands
 *  in the empty parentheses, which is where the url has to go. */
export function link(s: Sel, url = ""): Edit {
  const chosen = s.text.slice(s.start, s.end);
  const body = `[${chosen}](${url})`;
  const text = s.text.slice(0, s.start) + body + s.text.slice(s.end);
  const caret = s.start + (chosen ? chosen.length + 3 : 1);
  return { text, start: caret, end: caret + url.length };
}

/** The whole lines the selection touches — a list button pressed anywhere in a
 *  line applies to that line, not to the three characters under the cursor. */
function lineSpan(text: string, start: number, end: number): { from: number; to: number } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const nl = text.indexOf("\n", end);
  return { from, to: nl === -1 ? text.length : nl };
}

/**
 * A line prefix, on or off, over every line the selection touches.
 *
 * `- `, `1. `, `- [ ] `, `> ` are all the same operation, and all of them have
 * to be a TOGGLE: pressing the bullet button twice should give the text back,
 * not `- - item`.
 */
export function prefixLines(s: Sel, make: (i: number) => string): Edit {
  const { from, to } = lineSpan(s.text, s.start, s.end);
  const lines = s.text.slice(from, to).split("\n");
  const marks = lines.map((_, i) => make(i));
  const allOn = lines.every((l, i) => l.startsWith(marks[i]!));
  const out = lines.map((l, i) => (allOn ? l.slice(marks[i]!.length) : marks[i]! + l)).join("\n");
  const grew = out.length - (to - from);
  return {
    text: s.text.slice(0, from) + out + s.text.slice(to),
    start: s.start + (allOn ? -marks[0]!.length : marks[0]!.length),
    end: s.end + grew,
  };
}

export const bullet = (s: Sel): Edit => prefixLines(s, () => "- ");
export const ordered = (s: Sel): Edit => prefixLines(s, (i) => `${i + 1}. `);
export const checklist = (s: Sel): Edit => prefixLines(s, () => "- [ ] ");
export const quote = (s: Sel): Edit => prefixLines(s, () => "> ");
export const heading = (s: Sel): Edit => prefixLines(s, () => "## ");

/** A fenced block around the selection, on its own lines. */
export function fence(s: Sel, lang = ""): Edit {
  const chosen = s.text.slice(s.start, s.end);
  const before = s.text.slice(0, s.start);
  const after = s.text.slice(s.end);
  // Its own line, both ends: a fence that starts halfway through a sentence is
  // not a fence, it is three backticks in a sentence.
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const tail = after && !after.startsWith("\n") ? "\n" : "";
  const body = `${lead}\`\`\`${lang}\n${chosen}\n\`\`\`${tail}`;
  const caret = s.start + lead.length + 4 + lang.length;
  return { text: before + body + after, start: caret, end: caret + chosen.length };
}

/** A small table, ready to be typed over. */
export function table(s: Sel): Edit {
  const before = s.text.slice(0, s.start);
  const lead = before && !before.endsWith("\n") ? "\n" : "";
  const body = `${lead}| Column | Column |\n|---|---|\n|  |  |\n`;
  const at = before.length + lead.length + 2;
  return { text: before + body + s.text.slice(s.end), start: at, end: at + 6 };
}

/**
 * Enter inside a list carries the list on, and an empty item ends it.
 *
 * Returns null when the key means what it always means, so the caller can let
 * the textarea handle it.
 */
export function newline(s: Sel): Edit | null {
  const from = s.text.lastIndexOf("\n", s.start - 1) + 1;
  const line = s.text.slice(from, s.start);
  const m = /^(\s*)(-\s\[[ xX]\]\s|[-*+]\s|\d+\.\s)(.*)$/.exec(line);
  if (!m) return null;
  const [, indent, marker, rest] = m;
  if (!rest!.trim()) {
    // An empty item and Enter: end the list rather than adding another bullet.
    const text = s.text.slice(0, from) + s.text.slice(s.start);
    return { text, start: from, end: from };
  }
  const next = /^\d+\.\s$/.test(marker!)
    ? `${Number(marker!.trim().slice(0, -1)) + 1}. `
    // A checked box does not carry its tick to the next line.
    : marker!.replace(/\[[xX]\]/, "[ ]");
  const insert = `\n${indent}${next}`;
  const text = s.text.slice(0, s.start) + insert + s.text.slice(s.end);
  const caret = s.start + insert.length;
  return { text, start: caret, end: caret };
}
