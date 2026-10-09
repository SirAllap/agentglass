/*
 * Two ways to narrow a listing without leaving the box: a glob typed into it,
 * and chips for the kinds of file that are actually there.
 *
 * Both were asked for on the same evidence. Typing
 * `~/Documents/projects/orbit/shots/*.png` answered "Nothing in here matches":
 * the path was understood, and then its last segment, `*.png`, was scored as a
 * fuzzy name — no file is called that. And a folder of screenshots, pages and
 * notes is narrowed by kind far more often than by name, which is a click when
 * the kinds are shown and a syntax to remember when they are not.
 *
 * Ceiling, on purpose: the glob is the LAST segment only (`~/a/b/*.png`; a
 * pattern in a middle segment is not read), and it filters the folder you are looking at rather than walking
 * below it. A recursive `**` search is what the server's find is for.
 */

/** Does this text ask for a pattern? `*` and `?` always do; a class `[a-c]`
 *  and an alternation `{png,html}` only when they are well formed, so a name
 *  that merely contains a bracket is still a name. */
export function hasGlob(s: string): boolean {
  return /[*?]/.test(s) || /\{[^{}]*,[^{}]*\}/.test(s) || /\[[^\]]+\]/.test(s);
}

const escapeChar = (c: string) => c.replace(/[.+^$()|\\/{}[\]*?-]/g, "\\$&");

/** A glob as a regular expression over one name (or one path with `/`), or
 *  null when it cannot be one. Case-insensitive: file names are searched, not
 *  spelled. `*` stays inside a segment, `**` crosses them. */
export function globToRegExp(pattern: string): RegExp | null {
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i]!;
    if (c === "*") {
      if (pattern[i + 1] === "*") { out += ".*"; i += 2; if (pattern[i] === "/") i++; continue; }
      out += "[^/]*"; i++; continue;
    }
    if (c === "?") { out += "[^/]"; i++; continue; }
    if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end > i) {
        const alts = pattern.slice(i + 1, end).split(",").map((a) => a.split("").map(escapeChar).join(""));
        out += `(?:${alts.join("|")})`; i = end + 1; continue;
      }
    }
    if (c === "[") {
      const end = pattern.indexOf("]", i + 2);
      if (end > i) {
        let body = pattern.slice(i + 1, end);
        let neg = "";
        if (body[0] === "!" || body[0] === "^") { neg = "^"; body = body.slice(1); }
        out += `[${neg}${body.replace(/\\/g, "\\\\").replace(/]/g, "\\]")}]`; i = end + 1; continue;
      }
    }
    out += escapeChar(c); i++;
  }
  try { return new RegExp(`^${out}$`, "i"); } catch { return null; }
}

/** A pattern with no `/` is about the NAME — `*.png` finds a png wherever the
 *  row's path puts it; one with a slash is about the whole relative path. */
export function matchGlob(pattern: string, rel: string): boolean {
  const re = globToRegExp(pattern);
  if (!re) return false;
  return re.test(pattern.includes("/") ? rel : rel.slice(rel.lastIndexOf("/") + 1));
}

/* -------------------------------------------------------------------- chips */

export interface ExtChip { ext: string; count: number }

/** The extension a chip is filed under, lowercase, without the dot. "" is a
 *  file with none (`Makefile`, `LICENSE`) — and a dotfile like `.env` has none
 *  either, rather than an extension called "env". */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** The kinds present in what is on screen, most common first. Only files: a
 *  folder has no extension and counting it would put "none" on every listing.
 *  Ties break alphabetically, "none" last, so the row does not reshuffle between renders. */
export function extChips(names: string[]): ExtChip[] {
  const n = new Map<string, number>();
  for (const name of names) { const e = extOf(name); n.set(e, (n.get(e) ?? 0) + 1); }
  return [...n].map(([ext, count]) => ({ ext, count }))
    .sort((a, b) => b.count - a.count || (a.ext || "\uffff").localeCompare(b.ext || "\uffff"));
}

/** Click adds the kind, click again takes it away. Several at once is an OR. */
export function toggleExt(selected: string[], ext: string): string[] {
  return selected.includes(ext) ? selected.filter((e) => e !== ext) : [...selected, ext];
}

/** No chip selected means no filter. */
export function passesExts(name: string, selected: string[]): boolean {
  return selected.length === 0 || selected.includes(extOf(name));
}

/** What a chip says. */
export const chipLabel = (c: ExtChip): string => (c.ext || "none");
