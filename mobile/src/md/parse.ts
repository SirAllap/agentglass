/*
 * The markdown a pull request actually contains, and nothing else.
 *
 * Three screens used to print a body verbatim with a note saying markdown was
 * not rendered because "half-rendered markup reads worse than what somebody
 * wrote". That was true of half a renderer. What it cost was a checklist —
 * every pull request in this project opens with one — read as a wall of
 * `- [x]` and a description cut off at 1,200 characters.
 *
 * So this is deliberately not CommonMark. It is the constructs that turn up in
 * a body, an issue and a card description, parsed line by line the way
 * `model/diffLines.ts` parses a diff, and everything else kept as the text
 * somebody typed. An unknown construct renders as itself; nothing is ever
 * swallowed. That rule is what makes a bounded parser honest rather than
 * lossy — the failure mode of a big one is a blank where a paragraph was.
 *
 * What is here: headings, paragraphs, bullet/ordered/task lists with nesting,
 * fenced code, blockquotes, rules, tables, images, and inline code, links,
 * bold and italic.
 *
 * What is not, on purpose: raw HTML (dropped, see below), footnotes,
 * definition lists, setext headings, reference links, nested blockquotes
 * inside lists. None of them has appeared in a body this app has shown, and
 * each is a rule that can only be wrong in a way nobody would notice.
 */

import { EMOJI, htmlTableCells, matchingClose, parseShieldBadge, stripTags } from "../../../shared/mdHtml.ts";

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "link"; href: string; kids: Inline[] }
  | { t: "strong"; kids: Inline[] }
  | { t: "em"; kids: Inline[] }
  /** A picture written in a sentence, as `![alt](src)` or as the `<img>` tag
   *  GitHub writes when a screenshot is pasted. Lifted out of the paragraph into
   *  its own block (`flow`) wherever a block can hold it; drawn as its alt text
   *  only where one cannot (a heading, a table cell). */
  | { t: "image"; src: string; alt: string }
  /** A shields.io badge, drawn from the words in its address rather than
   *  fetched — see parseShieldBadge. */
  | { t: "badge"; label: string; value: string; color: string };

export interface ListItem {
  /** `null` for an ordinary bullet; a task list carries its state. */
  checked: boolean | null;
  kids: Inline[];
  /** A nested list under this item. One level is common in a checklist; the
   *  parser allows any depth because refusing at two would be arbitrary. */
  children: Block[];
}

export type Block =
  | { t: "p"; kids: Inline[] }
  | { t: "h"; level: number; kids: Inline[] }
  | { t: "code"; text: string; lang: string | null }
  | { t: "quote"; blocks: Block[] }
  | { t: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { t: "hr" }
  | { t: "table"; head: Inline[][]; rows: Inline[][][] }
  | { t: "image"; src: string; alt: string }
  /** A `<details>` fold. The summary is text; the inside is a document of its
   *  own, so a folded bot comment keeps its lists, tables and code. */
  | { t: "details"; summary: string; blocks: Block[] };

/** What a body is read against: the repository a bare `#123` belongs to. */
export interface MdContext { repo?: string }

/**
 * Drop HTML comments.
 *
 * `<!-- pr-template-nudge -->` opens a bot comment this app shows every day.
 * Dropped rather than escaped: it is addressed to a machine, and printing it
 * would be printing the one thing the author meant to hide.
 *
 * A scanner rather than a pattern. The obvious `/<!--[\s\S]*?-->/g` agrees with
 * a browser on the comment a bot writes and disagrees on every short one: HTML
 * ends a comment at `<!-->` and at `<!--->` before it has begun, and at `--!>`
 * as well as at `-->`. A filter that misses those leaves the reader looking at
 * markup the author hid, so this follows the parser browsers follow.
 */
function stripComments(src: string): string {
  let out = "";
  let at = 0;
  for (;;) {
    const open = src.indexOf("<!--", at);
    if (open < 0) return out + src.slice(at);
    out += src.slice(at, open);
    let i = open + 4;
    // `<!-->` and `<!--->` are a whole comment, empty and already closed.
    if (src.startsWith(">", i)) { at = i + 1; continue; }
    if (src.startsWith("->", i)) { at = i + 2; continue; }
    for (;;) {
      const dash = src.indexOf("--", i);
      if (dash < 0) return out;          // unterminated: the rest is comment
      if (src.startsWith("-->", dash)) { at = dash + 3; break; }
      if (src.startsWith("--!>", dash)) { at = dash + 4; break; }
      i = dash + 2;
    }
  }
}

const FENCE = /^(\s*)(```+|~~~+)\s*([^\s`]*)/;
const HEADING = /^(#{1,6})\s+(.*)$/;
/**
 * `---`, `***`, `___` — three or more of one mark, spaces allowed between.
 *
 * A loop rather than `(?:\s*\1){2,}`, which is the same quadratic shape as the
 * table rule above: a repeated group with an optional-space run inside it.
 */
function isBreak(line: string): boolean {
  const body = line.trim();
  if (body.length < 3) return false;
  const mark = body[0]!;
  if (mark !== "-" && mark !== "*" && mark !== "_") return false;
  let seen = 0;
  for (const ch of body) {
    if (ch === mark) seen++;
    else if (ch !== " " && ch !== "\t") return false;
  }
  return seen >= 3;
}
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^(\s*)([-*+])\s+(.*)$/;
const ORDERED = /^(\s*)(\d{1,9})[.)]\s+(.*)$/;
const TASK = /^\[([ xX])\]\s+(.*)$/;
/** One column of a table's rule row: `---`, `:--`, `--:` or `:-:`. Anchored,
 *  with a single quantifier and nothing ambiguous around it. */
const RULE_CELL = /^:?-+:?$/;

/**
 * Is this the `| --- | --- |` row under a table's header?
 *
 * Split and checked rather than matched by one expression. The expression this
 * replaced repeated a group that contained `\s*` on both sides of a `-{1,}`,
 * which backtracks quadratically on a long line of dashes — and every line here
 * comes from a pull request body, which is text a stranger wrote. Splitting on
 * the pipes is linear whatever the line is.
 */
function isTableRule(line: string): boolean {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  if (cells.length < 2) return false;
  return cells.every((cell) => RULE_CELL.test(cell.trim()));
}
const IMAGE_ONLY = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)$/;

/** Does this line close a fence opened with `marker`? At least as many of the
 *  same character, and nothing else. Built by hand rather than by compiling a
 *  regex per line out of text somebody else wrote. */
function closesFence(line: string, marker: string): boolean {
  const body = line.trim();
  if (body.length < marker.length) return false;
  for (const ch of body) if (ch !== marker[0]) return false;
  return true;
}

/** How far in a line is, with a tab counted as the four spaces a phone shows. */
const indentOf = (s: string): number => {
  let n = 0;
  for (const ch of s) {
    if (ch === " ") n += 1;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
};

/**
 * Turn a body into blocks.
 *
 * Line-based and single-pass, with one lookahead for a table's rule row. The
 * only recursion is into a blockquote and into a nested list, both of which
 * re-enter here with the outer marker stripped — so a construct behaves the
 * same wherever it appears.
 */
export function parseMarkdown(src: string, ctx: MdContext = {}): Block[] {
  const text = stripComments(src ?? "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines, ctx.repo);
}

function parseLines(lines: string[], repo?: string): Block[] {
  const out: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (!line.trim()) { i++; continue; }

    // Fenced code first: everything inside it is text, including what would
    // otherwise be a heading or a list.
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[2]!;
      const lang = fence[3] ? fence[3] : null;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closesFence(lines[i]!, marker)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // the closing fence, or the end of the text
      out.push({ t: "code", text: body.join("\n"), lang });
      continue;
    }

    if (isBreak(line)) { out.push({ t: "hr" }); i++; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      out.push({ t: "h", level: heading[1]!.length, kids: parseInline(heading[2]!.replace(/\s+#+\s*$/, ""), repo) });
      i++;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const body: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (q) { body.push(q[1]!); i++; continue; }
        // A blank line ends the quote; a plain line does not, because GitHub's
        // "lazy continuation" lets a wrapped sentence lose its `>`.
        if (!lines[i]!.trim()) break;
        body.push(lines[i]!);
        i++;
      }
      out.push({ t: "quote", blocks: parseLines(body, repo) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i, repo);
      out.push(list);
      i = next;
      continue;
    }

    // An HTML table, which is how the coverage bots write theirs, and like the
    // fold below usually on ONE line: break the line at the tag, then take
    // everything up to `</table>` as one block.
    const tableAt = line.search(/<table\b/i);
    if (tableAt > 0) {
      lines.splice(i, 1, line.slice(0, tableAt), line.slice(tableAt));
      continue;
    }
    if (tableAt === 0) {
      const rest = lines.slice(i).join("\n");
      const close = rest.search(/<\/table>/i);
      const cells = htmlTableCells(close < 0 ? rest : rest.slice(0, close));
      if (cells) {
        out.push({
          t: "table",
          head: cells.head.map((c) => parseInline(c, repo)),
          rows: cells.rows.map((r) => r.map((c) => parseInline(c, repo))),
        });
      }
      if (close < 0) break; // never closed: the table took the rest with it
      i = resume(lines, i, rest, close + "</table>".length);
      continue;
    }

    // `<details>`: everything up to the matching `</details>` is a small
    // document of its own. Scanned as text from the opening tag, not by line:
    // the opener carries its `<summary>`, the closer sticks to the last word.
    if (/^\s*<details\b/i.test(line)) {
      const open = /^\s*<details\b[^>]*>/i.exec(line)!;
      const rest = [line.slice(open[0].length), ...lines.slice(i + 1)].join("\n");
      const close = matchingClose(rest);
      const raw = close ? rest.slice(0, close.start) : rest;
      // Only THIS fold's summary: one after a nested `<details>` is the inner's.
      let summary = "";
      let inner = raw;
      const sum = /<summary\b[^>]*>([\s\S]*?)<\/summary>/i.exec(raw);
      const nested = raw.search(/<details\b/i);
      if (sum && (nested < 0 || sum.index < nested)) {
        summary = stripTags(sum[1]!).replace(/\s+/g, " ").trim();
        inner = raw.slice(0, sum.index) + raw.slice(sum.index + sum[0].length);
      }
      out.push({ t: "details", summary: summary || "Details", blocks: parseLines(inner.split("\n"), repo) });
      if (!close) break; // never closed: the fold took the rest of the document
      // Resume at whatever followed `</details>`: the tail of a line as often
      // as the next one, so two folds on one line come out as two.
      i = resume(lines, i, rest, close.end);
      continue;
    }

    // A table is only a table with its rule row under the header; without one,
    // a line of pipes is a sentence about pipes.
    if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = splitRow(line, repo);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!, repo));
        i++;
      }
      out.push({ t: "table", head, rows });
      continue;
    }

    const image = IMAGE_ONLY.exec(line.trim());
    if (image && /^https?:\/\//i.test(image[2]!) && !parseShieldBadge(image[2]!)) { out.push({ t: "image", alt: image[1]!, src: image[2]! }); i++; continue; }

    // A paragraph runs to the blank line, or to the first line that starts
    // something else — otherwise a list written straight under a sentence, which
    // is how people write them, is eaten by the sentence.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim()) {
      const at = lines[i]!;
      if (para.length && (HEADING.test(at) || isBreak(at) || FENCE.test(at) || QUOTE.test(at)
        || BULLET.test(at) || ORDERED.test(at) || /^\s*<(details|table)\b/i.test(at))) break;
      para.push(at.trim());
      i++;
    }
    out.push(...flow(parseInline(para.join(" "), repo)));
  }

  return out;
}

/** The image an inline span stands for, when it is nothing but one: a bare
 *  picture, or the `[![badge](img)](href)` a README wraps it in. */
function loneImage(k: Inline): { src: string; alt: string } | null {
  if (k.t === "image") return k;
  const only = k.t === "link" && k.kids.length === 1 ? k.kids[0] : undefined;
  return only?.t === "image" ? only : null;
}

/**
 * A run of spans as blocks, with every picture in its own.
 *
 * A phone cannot lay an image out inside a sentence, and the old answer —
 * the alt text as a link — meant a pasted screenshot arrived as a blue word.
 * The text on either side stays a paragraph, in order, so the picture sits
 * where the author put it.
 */
function flow(kids: Inline[]): Block[] {
  const out: Block[] = [];
  let run: Inline[] = [];
  const flush = (): void => {
    const blank = run.every((k) => k.t === "text" && !k.text.trim());
    if (run.length && !blank) out.push({ t: "p", kids: run });
    run = [];
  };
  for (const k of kids) {
    const img = loneImage(k);
    if (img) { flush(); out.push({ t: "image", src: img.src, alt: img.alt }); } else run.push(k);
  }
  flush();
  return out;
}

/** Where reading goes on after a block that was scanned as text: `rest` is
 *  the lines from `i` joined, `end` the offset it stopped at. The line it
 *  stopped in is rewritten to its tail and read again — and is what `i` is. */
function resume(lines: string[], i: number, rest: string, end: number): number {
  const eaten = rest.slice(0, end).split("\n").length - 1;
  lines[i + eaten] = rest.slice(end).split("\n")[0]!;
  return i + eaten;
}

/** One list, and where it ends. Items at a deeper indent belong to the item
 *  above them and are parsed as their own blocks. */
function parseList(lines: string[], from: number, repo?: string): [Block, number] {
  const first = BULLET.exec(lines[from]!) ?? ORDERED.exec(lines[from]!);
  const ordered = !BULLET.test(lines[from]!);
  const baseIndent = indentOf(lines[from]!);
  const start = ordered ? Number(first![2]) : 1;
  const items: ListItem[] = [];
  let i = from;

  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) {
      // A blank line inside a list is only a break if what follows is not a
      // deeper line: `- a\n\n- b` is one list to every reader.
      const nextAt = lines[i + 1];
      if (!nextAt || (!BULLET.test(nextAt) && !ORDERED.test(nextAt))) break;
      i++;
      continue;
    }
    const m = BULLET.exec(line) ?? ORDERED.exec(line);
    if (!m) break;
    const indent = indentOf(line);
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // Deeper: everything at this indent or more belongs to the last item.
      const nested: string[] = [];
      while (i < lines.length && (indentOf(lines[i]!) > baseIndent || !lines[i]!.trim())) {
        if (!lines[i]!.trim() && !(lines[i + 1] && indentOf(lines[i + 1]!) > baseIndent)) break;
        nested.push(lines[i]!.slice(baseIndent + 1));
        i++;
      }
      const owner = items[items.length - 1];
      if (owner) owner.children.push(...parseLines(nested, repo));
      continue;
    }
    // An ordered list cannot become a bullet list halfway down; that is a new
    // list and the caller will pick it up.
    if (ordered !== !BULLET.test(line)) break;

    const rest = m[3]!;
    const task = TASK.exec(rest);
    // A picture in an item goes under it, before any nested list.
    const [lead, ...below] = flow(parseInline(task ? task[2]! : rest, repo));
    items.push({
      checked: task ? task[1]!.toLowerCase() === "x" : null,
      kids: lead?.t === "p" ? lead.kids : [],
      children: lead && lead.t !== "p" ? [lead, ...below] : below,
    });
    i++;
  }

  return [{ t: "list", ordered, start, items }, i];
}

/** The cells of one table row, without the outer pipes. */
function splitRow(line: string, repo?: string): Inline[][] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // Split on pipes that are not inside a code span, so `| a \| b |` and
  // `` `a|b` `` both survive.
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") { cell += "|"; i++; continue; }
    if (ch === "`") code = !code;
    if (ch === "|" && !code) { cells.push(cell); cell = ""; continue; }
    cell += ch;
  }
  cells.push(cell);
  return cells.map((c) => parseInline(c.trim(), repo));
}

const CODE_SPAN = /^(`+)([\s\S]*?)\1/;
const SAFE_LINK = /^(?:https?:\/\/|mailto:)/i;
const LINK = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const IMAGE_INLINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
/** `[![alt](img)](href)` — the `[^\]]*` of LINK would close on the image's own
 *  bracket and call `![alt` a link to the picture. */
const IMAGE_LINKED = /^\[(!\[[^\]]*\]\([^)\s]+(?:\s+"[^"]*")?\))\]\([^)\s]+(?:\s+"[^"]*")?\)/;
/** The tag, with nothing in it that can close early: `[^>]*` is one quantifier. */
const HTML_IMG = /^(?:<a\b[^>]*>\s*)?<img\b[^>]*>(?:\s*<\/a>)?/i;
const EMOJI_CODE = /^:([a-z0-9_+-]{2,32}):/;
const ISSUE_REF = /^#(\d{1,7})(?!\w)/;
/** A picture, or the pill a shields.io address spells out — the badge is read,
 *  never fetched: a request per comment to a host the proxy does not allow. */
function pictureOrBadge(src: string, alt: string): Inline {
  // A body is text somebody else wrote: only a web address is fetched, the same
  // rule the desktop's renderer applies. Anything else is named, never loaded.
  if (!/^https?:\/\//i.test(src)) return { t: "text", text: alt ? `[image: ${alt}]` : "[image]" };
  const badge = parseShieldBadge(src);
  return badge ? { t: "badge", ...badge } : { t: "image", src, alt };
}
const HTML_SRC = /\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const HTML_ALT = /\balt\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const AUTOLINK = /^<((?:https?):\/\/[^>\s]+)>/;
/** A bare address, which is how the CU reference is written in this project's
 *  own template. One quantifier and no lookahead: the two adjacent character
 *  classes this used to end with overlap, which is the third quadratic shape in
 *  this file. The trailing punctuation is trimmed below instead. */
const BARE_URL = /^https?:\/\/[^\s<]+/;
/** What a URL at the end of a sentence should not swallow. */
const URL_TAIL = ".,:;!?)]}\"'";
const STRONG = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/;
const EM = /^(\*|_)(?=\S)([\s\S]*?\S)\1/;

/**
 * The spans inside a line.
 *
 * Code first, always: what is inside a code span is text, and a glob written
 * with two stars in one would otherwise turn the rest of the sentence bold.
 */
export function parseInline(src: string, repo?: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = (): void => { if (text) { out.push({ t: "text", text }); text = ""; } };

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest[0] === "\\" && rest.length > 1) { text += rest[1]; i += 2; continue; }

    const code = CODE_SPAN.exec(rest);
    if (code) { flush(); out.push({ t: "code", text: code[2]!.trim() }); i += code[0].length; continue; }

    // `:tada:` — only the shortcodes that turn up in a body, see EMOJI.
    if (rest[0] === ":") {
      const code = EMOJI_CODE.exec(rest);
      const glyph = code ? EMOJI[code[1]!] : undefined;
      if (code && glyph) { text += glyph; i += code[0].length; continue; }
    }

    // `#123` is a link to that issue or pull request in THIS repository, and
    // only with one known. Not after a word character: `abc#1` and `&#39;` are
    // not references.
    if (repo && rest[0] === "#" && !/[\w&]/.test(src[i - 1] ?? " ")) {
      const ref = ISSUE_REF.exec(rest);
      if (ref) {
        flush();
        out.push({ t: "link", href: `https://github.com/${repo}/issues/${ref[1]}`, kids: [{ t: "text", text: ref[0] }] });
        i += ref[0].length;
        continue;
      }
    }

    const img = IMAGE_INLINE.exec(rest);
    if (img) { flush(); out.push(pictureOrBadge(img[2]!, img[1]!)); i += img[0].length; continue; }

    const linked = IMAGE_LINKED.exec(rest);
    if (linked) {
      flush();
      const inner = IMAGE_INLINE.exec(linked[1]!)!;
      out.push(pictureOrBadge(inner[2]!, inner[1]!));
      i += linked[0].length;
      continue;
    }

    // `<img width="600" src="…">`, which is what GitHub writes for a pasted
    // screenshot. Raw HTML is dropped everywhere else; a picture is the one tag
    // whose loss leaves a hole where the evidence was. No http(s) source means
    // nothing to fetch, so that tag is dropped like the rest.
    if (rest[0] === "<" || rest.startsWith("<a")) {
      const tag = HTML_IMG.exec(rest);
      if (tag) {
        const src = HTML_SRC.exec(tag[0]);
        const url = src ? (src[1] ?? src[2] ?? "") : "";
        flush();
        if (/^https?:\/\//i.test(url)) {
          const alt = HTML_ALT.exec(tag[0]);
          out.push(pictureOrBadge(url.replace(/&amp;/g, "&"), alt ? (alt[1] ?? alt[2] ?? "") : ""));
        }
        i += tag[0].length;
        continue;
      }
    }

    const link = LINK.exec(rest);
    if (link) {
      flush();
      // Tapping a link hands its address to the system. A body is text somebody
      // else wrote, so only web and mail addresses stay links (the desktop's
      // renderer allows http(s) alone); any other scheme, or a path that goes
      // nowhere, keeps its label as plain text.
      if (SAFE_LINK.test(link[2]!)) out.push({ t: "link", href: link[2]!, kids: parseInline(link[1]!) });
      else out.push(...parseInline(link[1]!));
      i += link[0].length;
      continue;
    }

    const auto = AUTOLINK.exec(rest);
    if (auto) {
      flush();
      out.push({ t: "link", href: auto[1]!, kids: [{ t: "text", text: auto[1]! }] });
      i += auto[0].length;
      continue;
    }

    if (rest[0] === "h") {
      const bare = BARE_URL.exec(rest);
      if (bare) {
        let href = bare[0];
        while (href.length > "https://".length && URL_TAIL.includes(href[href.length - 1]!)) {
          href = href.slice(0, -1);
        }
        flush();
        out.push({ t: "link", href, kids: [{ t: "text", text: href }] });
        i += href.length;
        continue;
      }
    }

    const strong = STRONG.exec(rest);
    if (strong) { flush(); out.push({ t: "strong", kids: parseInline(strong[2]!, repo) }); i += strong[0].length; continue; }

    const em = EM.exec(rest);
    if (em) { flush(); out.push({ t: "em", kids: parseInline(em[2]!, repo) }); i += em[0].length; continue; }

    text += rest[0];
    i++;
  }

  flush();
  return out;
}

/** The plain text of a run of spans — for a row that has one line to give a
 *  thread, and for tests that care about what was kept rather than how. */
export function inlineText(kids: Inline[]): string {
  return kids.map((k) => (k.t === "text" || k.t === "code" ? k.text
    : k.t === "image" ? k.alt
    : k.t === "badge" ? [k.label, k.value].filter(Boolean).join(" ")
    : inlineText(k.kids))).join("");
}

/**
 * One already-chosen line, with its markdown taken off rather than shown.
 *
 * For a one-line preview that has no `Md` under it to render the syntax —
 * the Talk tab's collapsed bot row, a thread's opening remark — so
 * `**87.4%**` read as asterisks rather than as bold. `parseInline` already
 * separates the syntax from the words for the real renderer; this is the
 * same split with only the words kept.
 */
export function plainInline(text: string): string {
  return inlineText(parseInline(text));
}

/**
 * How many blocks a folded body shows.
 *
 * The limit, unless the first picture sits just past it: a fold that cuts
 * between a sentence and the screenshot it introduces hides the one thing the
 * reader came for, and the expander says "and 3 more" over it. A picture far
 * down (more than three times the limit) is not chased — that is a document,
 * not a description with evidence in it.
 */
export function foldAt(blocks: Block[], limit: number): number {
  const at = blocks.findIndex((b) => b.t === "image");
  return at >= limit && at < limit * 3 ? at + 1 : limit;
}
