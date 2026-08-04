// A pull request body is markdown, and the parts people actually write are a
// small, knowable set: headings, lists, task lists, tables, fenced code,
// blockquotes, links and screenshots. This renders those properly rather than
// almost-properly.
//
// Two rules run through it:
//
// 1. Everything is escaped first and only recognised constructs are put back.
//    A body is written by anyone who can open a pull request, so it is never
//    trusted input — no raw HTML survives except the images lifted out
//    deliberately, which go through the server's allowlisted proxy.
//
// 2. Every line rule splits on `\r?\n`. GitHub stores bodies with CRLF, and a
//    JavaScript regex `.` matches no line terminator — `\r` included — so a
//    naive split leaves a carriage return on every line and each `(.*)$` rule
//    silently matches nothing. That shipped once already: zero of nine
//    checkboxes found on a live pull request, with every `\n` fixture passing.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** The handful of entities GitHub emits in bodies it has round-tripped. */
function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ").replace(/&ndash;/g, "–").replace(/&mdash;/g, "—")
    .replace(/&#(\d+);/g, (_m, d: string) => { try { return String.fromCodePoint(Number(d)); } catch { return _m; } })
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

/**
 * Inline marks.
 *
 * Order matters: code spans come out first and go back last, so a `**` inside
 * backticks is never mistaken for bold. The placeholder is a private-use
 * codepoint rather than a digit — a bare index would collide with any number in
 * the prose around it, which is how "1" became a code span once.
 */
const SLOT = "";

/** The shortcodes that actually turn up in pull requests. Not the whole set —
 *  a thousand-entry table for a handful of real uses is weight for nothing. */
const EMOJI: Record<string, string> = {
  tada: "🎉", rocket: "🚀", sparkles: "✨", bug: "🐛", fire: "🔥", warning: "⚠️",
  white_check_mark: "✅", heavy_check_mark: "✔️", x: "❌", "+1": "👍", "-1": "👎",
  eyes: "👀", heart: "❤️", pray: "🙏", clap: "👏", wrench: "🔧", hammer: "🔨",
  memo: "📝", books: "📚", lock: "🔒", zap: "⚡", boom: "💥", art: "🎨",
  recycle: "♻️", construction: "🚧", bulb: "💡", mag: "🔍", package: "📦",
  robot: "🤖", ok_hand: "👌",
};

export function renderInline(raw: string, autolinkRepo?: string): string {
  const spans: string[] = [];
  let s = decodeEntities(raw).replace(/`([^`]+)`/g, (_m, code: string) => {
    spans.push(`<code>${escapeHtml(code)}</code>`);
    return `${SLOT}${spans.length - 1}${SLOT}`;
  });

  s = escapeHtml(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");

  // http(s) only — a markdown link is a fine place to hide `javascript:`.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer noopener">${text}</a>`);
  s = s.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_m, pre: string, href: string) => `${pre}<a href="${href}" target="_blank" rel="noreferrer noopener">${href}</a>`);

  // `:tada:` and friends. GitHub renders these everywhere and a bot's release
  // notes are full of them; unrendered they read as punctuation soup.
  s = s.replace(/:([a-z0-9_+-]{2,32}):/g, (m, name: string) => EMOJI[name] ?? m);

  // `#123`, `owner/repo#123`, and bare SHAs — the references a pull request
  // body is mostly made of. Linked against the repo this body belongs to, which
  // the caller supplies; without it they stay as text rather than guessing.
  if (autolinkRepo) {
    s = s.replace(/(^|[\s(])(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/g,
      (_m, pre: string, repo: string | undefined, num: string) =>
        `${pre}<a href="https://github.com/${repo ?? autolinkRepo}/issues/${num}" target="_blank" rel="noreferrer noopener">${repo ?? ""}#${num}</a>`);
    s = s.replace(/(^|[\s(])([0-9a-f]{7,40})\b/g,
      (_m, pre: string, sha: string) =>
        `${pre}<a href="https://github.com/${autolinkRepo}/commit/${sha}" target="_blank" rel="noreferrer noopener"><code>${sha.slice(0, 7)}</code></a>`);
  }

  return s.replace(new RegExp(`${SLOT}(\\d+)${SLOT}`, "g"), (_m, i: string) => spans[Number(i)] ?? "");
}

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

export type MdListItem = { html: string; checked?: boolean; depth: number };

export type MdBlock =
  | { kind: "heading"; level: number; html: string }
  | { kind: "para"; html: string }
  | { kind: "list"; ordered: boolean; items: MdListItem[] }
  | { kind: "code"; text: string; lang?: string }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quote"; html: string }
  | { kind: "image"; src: string; alt: string }
  /** `<details><summary>…` — what every bot folds its output into. Rendered as
   *  a real disclosure rather than escaped tags. */
  | { kind: "details"; summary: string; blocks: MdBlock[] }
  /** GitHub's callouts: `> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`, `[!WARNING]`,
   *  `[!CAUTION]`. */
  | { kind: "alert"; level: "note" | "tip" | "important" | "warning" | "caution"; html: string }
  /** A ```suggestion block: the replacement the author is proposing for the
   *  lines the comment is anchored to. Its own kind because it is a change to
   *  accept, not a snippet to read. */
  | { kind: "suggestion"; text: string }
  | { kind: "rule" };

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
function matchingClose(text: string): { start: number; end: number } | null {
  const re = /<(\/?)details\b[^>]*>/gi;
  let depth = 1;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (!m[1]) { depth++; continue; }
    if (--depth === 0) return { start: m.index, end: m.index + m[0].length };
  }
  return null;
}

/** A table cell is markdown too. Returning the raw text put `**Drift**` on
 *  screen with its asterisks — the bold that a RED/GREEN comparison leans on
 *  was exactly what stopped rendering. */
const cells = (l: string, repo?: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => renderInline(c.trim(), repo));
const isDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const IMG_MD = /^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/;
const IMG_HTML = /<img[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/i;

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
 * A table written as HTML rather than as pipes.
 *
 * Which is what the coverage bots emit, all on one line — so the markdown table
 * rule never saw it and the whole thing landed on screen as its own source. A
 * header row is `<th>`; a table with none gets its first row promoted, because
 * a table drawn with no head reads as if its first line of data were missing.
 */
export function parseHtmlTable(raw: string, autolinkRepo?: string): Extract<MdBlock, { kind: "table" }> | null {
  const rows: string[][] = [];
  let head: string[] = [];
  for (const tr of raw.match(/<tr\b[^>]*>[\s\S]*?<\/tr>/gi) ?? []) {
    const isHead = /<th\b/i.test(tr);
    const cells = (tr.match(/<t[hd]\b[^>]*>[\s\S]*?<\/t[hd]>/gi) ?? [])
      .map((c) => renderInline(htmlCellToMarkdown(c.replace(/^<t[hd]\b[^>]*>/i, "").replace(/<\/t[hd]>$/i, "")), autolinkRepo));
    if (!cells.length) continue;
    if (isHead && !head.length) head = cells;
    else rows.push(cells);
  }
  if (!head.length) {
    if (!rows.length) return null;
    head = rows.shift()!;
  }
  return { kind: "table", head, rows };
}

export function parseBody(body: string, autolinkRepo?: string): MdBlock[] {
  const out: MdBlock[] = [];
  // HTML comments are invisible on GitHub and were not on screen here, which is
  // how a coverage report opened with `<!-- Pytest Coverage Comment: … -->` and
  // closed with `<!-- Sticky Pull Request Comment… -->`. Bots use them as
  // machine markers — to find and rewrite their own comment later — so on a CI
  // comment they are most of the noise. Only whole-line comments go: one buried
  // mid-sentence is likelier to be someone demonstrating the syntax.
  const lines = (body || "").replace(/^[ \t]*<!--[\s\S]*?-->[ \t]*$/gm, "").split(/\r?\n/);
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push({ kind: "para", html: para.map((x) => renderInline(x, autolinkRepo)).join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // A fold does not have to start its own line. The coverage bots write
    //   <a href="…"><img alt="Coverage" src="…"></a><details><summary>…
    // all on one, and matching `<details>` only at the start of a line meant the
    // image rule below claimed the whole thing: the badge rendered and the fold
    // — the table, which is the entire content of the comment — was dropped on
    // the floor. Split the line in two and let each half meet its own rule.
    const dAt = line.search(/<details\b/i);
    if (dAt > 0) {
      lines.splice(i, 1, line.slice(0, dAt), line.slice(dAt));
      i -= 1;
      continue;
    }

    // An HTML <table>, which is how the coverage bots write theirs — and, like
    // the fold, all on one line. Same two steps: break the line at the tag, then
    // take everything up to </table> as one block.
    const tAt = line.search(/<table\b/i);
    if (tAt > 0) {
      lines.splice(i, 1, line.slice(0, tAt), line.slice(tAt));
      i -= 1;
      continue;
    }
    if (tAt === 0) {
      flushPara();
      const rest = [line, ...lines.slice(i + 1)].join("\n");
      const close = rest.search(/<\/table>/i);
      const tbl = parseHtmlTable(close < 0 ? rest : rest.slice(0, close), autolinkRepo);
      if (tbl) out.push(tbl);
      // Never closed: the table has taken the rest of the document with it.
      if (close < 0) break;
      const end = close + "</table>".length;
      const eaten = rest.slice(0, end).split("\n").length - 1;
      lines[i + eaten] = rest.slice(end).split("\n")[0]!;
      i += eaten - 1;
      continue;
    }

    // <details>: take everything up to the matching </details> and parse it as
    // its own little document, so a folded bot comment keeps its lists and code.
    //
    // The fold is handled as text from the opening tag onwards rather than line
    // by line, because none of the three things that go wrong are line-shaped:
    // the opener carries its `<summary>` on the same line, the closer is stuck
    // to the last word, the `<summary>` wraps over three lines. See
    // `matchingClose`.
    const det = line.match(/^\s*<details\b[^>]*>/i);
    if (det) {
      flushPara();
      const rest = [line.slice(det[0].length), ...lines.slice(i + 1)].join("\n");
      const close = matchingClose(rest);
      const raw = close ? rest.slice(0, close.start) : rest;

      // The summary, wherever it wrapped — and only this fold's own. A
      // `<summary>` that comes after a nested `<details>` belongs to that one,
      // and titling the outer fold with the inner's name is worse than leaving
      // it untitled.
      let summary = "";
      let inner = raw;
      const sum = raw.match(/<summary\b[^>]*>([\s\S]*?)<\/summary>/i);
      const nested = raw.search(/<details\b/i);
      if (sum && sum.index !== undefined && (nested < 0 || sum.index < nested)) {
        summary = stripTags(sum[1]!).replace(/\s+/g, " ").trim();
        inner = raw.slice(0, sum.index) + raw.slice(sum.index + sum[0].length);
      }

      out.push({ kind: "details", summary: summary || "Details", blocks: parseBody(inner, autolinkRepo) });

      // Never closed: the fold has taken the rest of the document with it.
      if (!close) break;
      // Otherwise resume at whatever followed `</details>`, which is the tail of
      // a line as often as it is the next one — so the line is rewritten to that
      // tail and read again. Two folds on one line come out as two folds.
      const eaten = rest.slice(0, close.end).split("\n").length - 1;
      lines[i + eaten] = rest.slice(close.end).split("\n")[0]!;
      i += eaten - 1;
      continue;
    }

    // > [!NOTE] and friends. The first line names the kind; the rest is the body.
    const alert = line.match(/^\s*>\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i);
    if (alert) {
      flushPara();
      const body: string[] = [];
      while (i + 1 < lines.length && /^\s*>/.test(lines[i + 1]!)) {
        body.push(lines[++i]!.replace(/^\s*>\s?/, ""));
      }
      out.push({
        kind: "alert",
        level: alert[1]!.toLowerCase() as "note",
        html: body.map((x) => renderInline(x, autolinkRepo)).join(" "),
      });
      continue;
    }

    const fence = line.match(/^\s*```+\s*(\S*)/);
    if (fence) {
      flushPara();
      const lang = fence[1] || undefined;
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) { buf.push(lines[i]!); i++; }
      // ```suggestion is a proposal, not a sample.
      if ((lang || "").toLowerCase() === "suggestion") out.push({ kind: "suggestion", text: buf.join("\n") });
      else out.push({ kind: "code", text: buf.join("\n"), lang });
      continue;
    }

    if (!line.trim()) { flushPara(); continue; }

    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flushPara(); out.push({ kind: "rule" }); continue; }

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); out.push({ kind: "heading", level: h[1]!.length, html: renderInline(h[2]!, autolinkRepo) }); continue; }

    const img = line.match(IMG_MD);
    if (img) { flushPara(); out.push({ kind: "image", src: img[2]!, alt: img[1]! }); continue; }
    const ihtml = line.match(IMG_HTML);
    if (ihtml) {
      flushPara();
      out.push({ kind: "image", src: ihtml[1]!, alt: line.match(/\balt="([^"]*)"/i)?.[1] ?? "" });
      continue;
    }

    // A table needs a header AND a divider, looked ahead: a lone pipe in prose
    // is not a table, and treating it as one ate the sentence.
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flushPara();
      const head = cells(line, autolinkRepo);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) { rows.push(cells(lines[i]!, autolinkRepo)); i++; }
      i--;
      out.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flushPara();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) { quoted.push(lines[i]!.replace(/^\s*>\s?/, "")); i++; }
      i--;
      out.push({ kind: "quote", html: quoted.map((x) => renderInline(x, autolinkRepo)).join(" ") });
      continue;
    }

    const li = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (li) {
      flushPara();
      const ordered = /\d/.test(li[2]!);
      const items: MdListItem[] = [];
      while (i < lines.length) {
        const m = lines[i]!.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
        if (!m) {
          // An indented continuation belongs to the item above it — GitHub's
          // own checklist wraps this way and it read as a stray paragraph.
          if (items.length && lines[i]!.trim() && /^\s{2,}\S/.test(lines[i]!)) {
            items[items.length - 1]!.html += " " + renderInline(lines[i]!.trim(), autolinkRepo);
            i++;
            continue;
          }
          break;
        }
        const depth = Math.min(4, Math.floor(m[1]!.replace(/\t/g, "  ").length / 2));
        const task = m[3]!.match(/^\[([ xX])\]\s+(.*)$/);
        items.push(task
          ? { html: renderInline(task[2]!, autolinkRepo), checked: task[1]!.toLowerCase() === "x", depth }
          : { html: renderInline(m[3]!, autolinkRepo), depth });
        i++;
      }
      i--;
      out.push({ kind: "list", ordered, items });
      continue;
    }

    para.push(line);
  }
  flushPara();
  return out;
}

/** Checklist boxes, for the merge-readiness signal on the overview. */
export function parseChecklist(body: string): { checked: boolean; text: string }[] {
  const out: { checked: boolean; text: string }[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const m = line.match(/^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/);
    if (!m) continue;
    out.push({ checked: m[1]!.toLowerCase() === "x", text: m[2]!.trim() });
  }
  return out;
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/** One unified diff, cut into per-file pieces. */
export function splitDiff(text: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!text) return out;
  let path = "";
  let buf: string[] = [];
  const flush = () => { if (path) out.set(path, buf.join("\n")); };
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (m) {
      flush();
      // The b-side: a rename shows its destination, which is how the file list
      // is keyed.
      path = m[2]!;
      buf = [line];
      continue;
    }
    if (path) buf.push(line);
  }
  flush();
  return out;
}

export interface ParsedHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }
export interface ParsedFile { path: string; additions: number; deletions: number; hunks: ParsedHunk[] }

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/i;

/**
 * Which viewer a changed file needs.
 *
 * The subtlety, and the bug this exists to stop coming back: `gh pr diff` still
 * emits a header for a binary file — `Binary files a/x and b/x differ`, and
 * nothing else — so the parser yields an entry with ZERO hunks rather than no
 * entry at all. Deciding on "is there a parsed file" therefore sent every PNG
 * down the text path and drew an empty diff, which is why the image viewer
 * never appeared. The count of hunks is the honest question.
 */
export function diffKind(path: string, hunks: number): "image" | "text" | "none" {
  if (hunks > 0) return "text";
  return IMAGE_EXT.test(path) ? "image" : "none";
}

/**
 * A unified diff, in the shape the app's own diff viewer already speaks.
 *
 * This is the whole trick behind files and commits looking like the rest of
 * agentglass: `SplitDiff`/`UnifiedDiff` take a `FileChange` carrying `hunks`,
 * so a pull request only has to be translated into that. No second diff
 * renderer, no second set of keybindings, and no drift between the two.
 */
export function parseUnifiedDiff(text: string): ParsedFile[] {
  const files: ParsedFile[] = [];
  let cur: ParsedFile | null = null;
  let hunk: ParsedHunk | null = null;

  for (const line of (text || "").split(/\r?\n/)) {
    const g = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (g) {
      cur = { path: g[2]!, additions: 0, deletions: 0, hunks: [] };
      files.push(cur);
      hunk = null;
      continue;
    }
    if (!cur) continue;
    const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (h) {
      hunk = {
        oldStart: Number(h[1]), oldLines: h[2] === undefined ? 1 : Number(h[2]),
        newStart: Number(h[3]), newLines: h[4] === undefined ? 1 : Number(h[4]),
        lines: [],
      };
      cur.hunks.push(hunk);
      continue;
    }
    if (!hunk) continue;
    // "\ No newline at end of file" is metadata about the file, not a line of it.
    if (line.startsWith("\\")) continue;
    if (line.startsWith("+")) { cur.additions++; hunk.lines.push(line); continue; }
    if (line.startsWith("-")) { cur.deletions++; hunk.lines.push(line); continue; }
    if (line.startsWith(" ")) { hunk.lines.push(line); continue; }
    // A truly empty line inside a hunk is a context line whose single leading
    // space some tools trim. Dropping it shifts every line number after it.
    if (line === "") { hunk.lines.push(" "); continue; }
  }
  return files;
}

/**
 * The line number a diff line lands on in the new file.
 *
 * Needed to anchor a review comment: GitHub's API wants the line in the file,
 * and what the viewer has is a position inside a hunk.
 */
export function newLineNumbers(hunk: ParsedHunk): (number | null)[] {
  let n = hunk.newStart;
  return hunk.lines.map((l) => (l.startsWith("-") ? null : n++));
}
