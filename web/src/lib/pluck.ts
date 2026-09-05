/*
 * PLUCK — the paths, hashes, ids and links on a pane's screen, as things you
 * can take without the mouse.
 *
 * An agent prints a path, a commit hash, a UUID, a URL; to use it you drag
 * over it, precisely, in a monospace grid that wraps long lines. Fourteen
 * tools in the same space solve it the same way: read the screen, find the
 * tokens, letter them, let a key pick one. Two details copied from the best of
 * them: the WRAP is undone before matching — xterm knows which rows are
 * continuations of the row above (`isWrapped`), so a URL broken across two
 * rows is one URL — and the token can be written straight into the pane
 * ("direct paste") without touching the clipboard, which is what you want
 * nine times in ten: the agent said a path, you want to say it back.
 *
 * Newest first, because the thing you want is almost always the last thing
 * printed; de-duplicated, because a path an agent edits appears eight times.
 */

export type PluckKind = "path" | "url" | "hash" | "uuid" | "ref";
export interface Pluck { text: string; kind: PluckKind; row: number }

/** One logical line per row-run: wrapped continuations joined to their head. */
export function unwrapRows(rows: { text: string; wrapped: boolean }[]): { text: string; row: number }[] {
  const out: { text: string; row: number }[] = [];
  rows.forEach((r, i) => {
    if (r.wrapped && out.length) out[out.length - 1]!.text += r.text;
    else out.push({ text: r.text, row: i });
  });
  return out;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const HASH_RE = /\b[0-9a-f]{7,40}\b/g;
/** Absolute, home-relative or explicitly relative paths, and bare
 *  `dir/file.ext(:line(:col))` shapes — the way tools print them. */
const PATH_RE = /(?:~|\.{1,2})?\/[\w.@+-][\w.@+\-/]*(?::\d+(?::\d+)?)?|\b[\w.@+-]+(?:\/[\w.@+-]+)+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/g;
/** Branch-ish refs: `feat/…`, `fix/…`, `origin/…`. */
const REF_RE = /\b(?:feat|fix|chore|docs|test|refactor|origin|release|hotfix)\/[\w.\-/]+/g;

const trimEnd = (s: string) => s.replace(/[.,;:)\]}'"`]+$/, "");

/** Every token on the screen, newest row first, each once. */
export function pluckTokens(rows: { text: string; wrapped: boolean }[], max = 26): Pluck[] {
  const seen = new Set<string>();
  const out: Pluck[] = [];
  const lines = unwrapRows(rows).reverse();
  const add = (text: string, kind: PluckKind, row: number) => {
    const t = trimEnd(text);
    if (t.length < 4 || seen.has(t)) return;
    seen.add(t);
    out.push({ text: t, kind, row });
  };
  for (const { text, row } of lines) {
    for (const m of text.matchAll(URL_RE)) add(m[0]!, "url", row);
    /* Everything else is matched with the links blanked out, so a path or a
       ref inside a URL is never offered a second time as a piece of it. */
    const rest = text.replace(URL_RE, (m) => " ".repeat(m.length));
    for (const m of rest.matchAll(UUID_RE)) add(m[0]!, "uuid", row);
    for (const m of rest.matchAll(PATH_RE)) {
      const t = m[0]!;
      // A version-ish "1.2/3" or a time is not a path.
      if (/^\d[\d./:]*$/.test(t)) continue;
      add(t, "path", row);
    }
    for (const m of rest.matchAll(REF_RE)) add(m[0]!, "ref", row);
    /* And the ids blanked before the hashes: a UUID's first block is eight
       hex digits, which is exactly what a short commit hash looks like. */
    const noIds = rest.replace(UUID_RE, (m) => " ".repeat(m.length));
    for (const m of noIds.matchAll(HASH_RE)) {
      const t = m[0]!;
      // Hex that is really a word ("deadbeef" aside, "add", "face" are too short — 7+ letters only, and never all digits).
      if (/^\d+$/.test(t)) continue;
      if (!/\d/.test(t)) continue; // a hash has digits in it; "cafebabe" is the rare loss
      add(t, "hash", row);
    }
    if (out.length >= max) break;
  }
  return out.slice(0, max);
}

/** The keys a pick is offered on: home row first, then the rest, never a key
 *  the palette itself uses (Escape, Enter, Shift). */
export const PLUCK_KEYS = "asdfghjklqwertyuiopzxcvbnm";
