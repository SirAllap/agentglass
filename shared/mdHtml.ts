/*
 * The HTML a pull request body or a comment is allowed to carry, read as text.
 *
 * Shared because the desktop and the phone both meet the same bot output: the
 * `<table>` a coverage comment is written in, the `<details>` fold around a long
 * one, the shields.io badge that opens it, the `:tada:` in a release note. Each
 * is a pure string function with no DOM and no renderer, so each lives once and
 * the two parsers (web/src/lib/prBody.ts, mobile/src/md/parse.ts) cannot drift
 * apart on what a fold or a badge IS. What they DRAW is their own.
 */

/** The shortcodes that actually turn up in pull requests. Not the whole set —
 *  a thousand-entry table for a handful of real uses is weight for nothing. */
export const EMOJI: Record<string, string> = {
  tada: "🎉", rocket: "🚀", sparkles: "✨", bug: "🐛", fire: "🔥", warning: "⚠️",
  white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌", "+1": "👍", "-1": "👎",
  eyes: "👀", heart: "❤️", pray: "🙏", clap: "👏", wrench: "🔧", hammer: "🔨",
  memo: "📝", books: "📚", lock: "🔒", zap: "⚡", boom: "💥", art: "🎨",
  recycle: "♻️", construction: "🚧", bulb: "💡", mag: "🔍", package: "📦",
  robot: "🤖", ok_hand: "👌",
};

/**
 * The text inside a `<summary>`, with any markup taken out.
 *
 * Stripping tags in one pass is the classic incomplete sanitisation: `<scr` +
 * `<b>` + `ipt>` survives as `<script>`, because removing the inner tag closes
 * the outer one up. Repeating until the string stops changing is what actually
 * removes them. The result is rendered as a React text child (escaped again on
 * the way out), so this is belt and braces rather than the only guard — but a
 * function that looks like a sanitiser has to be one.
 */
export function stripTags(raw: string): string {
  let prev = "";
  let out = raw;
  // Bounded, so a pathological input cannot spin here.
  for (let i = 0; i < 20 && out !== prev; i++) {
    prev = out;
    out = out.replace(/<[^<>]*>/g, "");
  }
  // Anything left that still looks like a tag opener is neutralised outright.
  return out.replace(/[<>]/g, "");
}

/**
 * Where the `</details>` closing an already-open `<details>` sits, counting
 * nested pairs — as offsets into the text, not a line number.
 *
 * Scanning for the tag instead of matching a line shape is the whole point. The
 * rule used to be "the tag sits alone on its line", and the shapes people
 * actually write do not oblige: `<details><summary>…</summary>` on one line is
 * the form GitHub's own documentation shows and the form every bot emits, and a
 * `</details>` pressed against the last word of the fold is just as common. Both
 * fell through to the paragraph rule and put escaped tags on screen — the
 * collapsed part of a collapsed comment being the one thing that did not work.
 *
 * Null when the fold is never closed. That is not an error: an unclosed
 * `<details>` owns the rest of the document, which is what a browser's parser
 * does with it too.
 */
export function matchingClose(text: string): { start: number; end: number } | null {
  const re = /<(\/?)details\b[^>]*>/gi;
  let depth = 1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[1]) { depth++; continue; }
    if (--depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/**
 * A shields.io badge, read rather than fetched.
 *
 * Every CI bot opens with one — `Coverage 75%`, `build passing` — as an SVG on
 * a third-party host. Fetching it means a request per comment to a domain the
 * asset proxy does not allow, so what actually appeared was a broken image
 * where the headline number should be. The URL already carries the label, the
 * value and the colour, so the pill is drawn from the text and nothing is
 * fetched at all.
 *
 * shields.io's own escaping: fields are separated by `-`, a doubled `--` is a
 * literal dash, `_` is a space and `__` a literal underscore. Two fields mean
 * message-colour, three or more mean label-message-colour with the label free
 * to contain its own separators.
 */
export function parseShieldBadge(src: string): { label: string; value: string; color: string } | null {
  const m = (src || "").match(/^https?:\/\/img\.shields\.io\/badge\/([^?#]+)/i);
  if (!m) return null;
  const path = m[1]!.replace(/\.(svg|png|json)$/i, "");
  const parts: string[] = [];
  let cur = "";
  for (let i = 0; i < path.length; i++) {
    if (path[i] === "-") {
      if (path[i + 1] === "-") { cur += "-"; i += 1; continue; }
      parts.push(cur); cur = ""; continue;
    }
    cur += path[i];
  }
  parts.push(cur);
  if (parts.length < 2) return null;
  const un = (s: string) => {
    let t = s;
    try { t = decodeURIComponent(s); } catch { /* a stray % is not a reason to drop the badge */ }
    // One pass, so a literal `__` is not swallowed by the `_`-to-space rule
    // and handed back as two spaces.
    return t.replace(/__|_/g, (x) => (x === "__" ? "_" : " "));
  };
  const color = parts[parts.length - 1]!;
  if (parts.length === 2) return { label: "", value: un(parts[0]!), color };
  return { label: un(parts.slice(0, -2).join("-")), value: un(parts[parts.length - 2]!), color };
}

/**
 * One HTML table cell, as markdown.
 *
 * The cells are not plain text — a coverage row is a link per file and a bold
 * TOTAL — and they cannot be passed through as HTML: the table renders with
 * `dangerouslySetInnerHTML`, so anything arriving from a comment has to go
 * through `renderInline`, which escapes the lot and then puts back only its own
 * markup. So the few tags worth keeping are turned into the markdown that means
 * the same thing, everything else is stripped, and `renderInline` decides what
 * is safe. `<a>` becomes a markdown link, which is http(s)-only there.
 */
export function htmlCellToMarkdown(html: string): string {
  const t = (html || "")
    // Only an http(s) target becomes a link. `renderInline` would refuse a
    // `javascript:` one anyway and leave it as escaped text, but that puts
    // `[x](javascript:alert(1))` on screen; dropping to the bare text says the
    // same thing without the litter.
    .replace(/<a\b[^>]*\bhref="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
      (_m, href: string, txt: string) => (/^https?:\/\//i.test(href) ? `[${stripTags(txt).trim()}](${href})` : stripTags(txt).trim()))
    .replace(/<(b|strong)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, txt: string) => `**${stripTags(txt).trim()}**`)
    .replace(/<(i|em)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _tag: string, txt: string) => `*${stripTags(txt).trim()}*`)
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_m, txt: string) => `\`${stripTags(txt).trim()}\``)
    .replace(/<br\s*\/?>/gi, " ");
  return stripTags(t).replace(/\s+/g, " ").trim();
}

/**
 * The rows of a table written as HTML, each cell already turned into markdown.
 *
 * A header row is `<th>`; a table with none gets its first row promoted, because
 * a table drawn with no head reads as if its first line of data were missing.
 * Null when there is no row at all. What a cell DRAWS as is the caller's: the
 * desktop escapes it and puts back its own markup, the phone parses it.
 */
export function htmlTableCells(raw: string): { head: string[]; rows: string[][] } | null {
  const rows: string[][] = [];
  let head: string[] = [];
  for (const tr of raw.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const isHead = /<th\b/i.test(tr);
    const cells = (tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? [])
      .map((c) => htmlCellToMarkdown(c.replace(/^<t[hd]\b[^>]*>/i, "").replace(/<\/t[hd]>$/i, "")));
    if (!cells.length) continue;
    if (isHead && !head.length) head = cells;
    else rows.push(cells);
  }
  if (!head.length) {
    if (!rows.length) return null;
    head = rows.shift()!;
  }
  return { head, rows };
}
