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

export type Inline =
  | { t: "text"; text: string }
  | { t: "code"; text: string }
  | { t: "link"; href: string; kids: Inline[] }
  | { t: "strong"; kids: Inline[] }
  | { t: "em"; kids: Inline[] };

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
  | { t: "image"; src: string; alt: string };

/** `<!-- pr-template-nudge -->` opens a bot comment this app shows every day.
 *  Dropped rather than escaped: it is addressed to a machine, and printing it
 *  would be printing the one thing the author meant to hide. */
const HTML_COMMENT = /<!--[\s\S]*?-->/g;

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
export function parseMarkdown(src: string): Block[] {
  const text = (src ?? "").replace(HTML_COMMENT, "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return parseLines(lines);
}

function parseLines(lines: string[]): Block[] {
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
      out.push({ t: "h", level: heading[1]!.length, kids: parseInline(heading[2]!.replace(/\s+#+\s*$/, "")) });
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
      out.push({ t: "quote", blocks: parseLines(body) });
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }

    // A table is only a table with its rule row under the header; without one,
    // a line of pipes is a sentence about pipes.
    if (line.includes("|") && i + 1 < lines.length && isTableRule(lines[i + 1]!)) {
      const head = splitRow(line);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      out.push({ t: "table", head, rows });
      continue;
    }

    const image = IMAGE_ONLY.exec(line.trim());
    if (image) { out.push({ t: "image", alt: image[1]!, src: image[2]! }); i++; continue; }

    // A paragraph runs to the blank line, or to the first line that starts
    // something else — otherwise a list written straight under a sentence, which
    // is how people write them, is eaten by the sentence.
    const para: string[] = [];
    while (i < lines.length && lines[i]!.trim()) {
      const at = lines[i]!;
      if (para.length && (HEADING.test(at) || isBreak(at) || FENCE.test(at) || QUOTE.test(at)
        || BULLET.test(at) || ORDERED.test(at))) break;
      para.push(at.trim());
      i++;
    }
    out.push({ t: "p", kids: parseInline(para.join(" ")) });
  }

  return out;
}

/** One list, and where it ends. Items at a deeper indent belong to the item
 *  above them and are parsed as their own blocks. */
function parseList(lines: string[], from: number): [Block, number] {
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
      if (owner) owner.children.push(...parseLines(nested));
      continue;
    }
    // An ordered list cannot become a bullet list halfway down; that is a new
    // list and the caller will pick it up.
    if (ordered !== !BULLET.test(line)) break;

    const rest = m[3]!;
    const task = TASK.exec(rest);
    items.push({
      checked: task ? task[1]!.toLowerCase() === "x" : null,
      kids: parseInline(task ? task[2]! : rest),
      children: [],
    });
    i++;
  }

  return [{ t: "list", ordered, start, items }, i];
}

/** The cells of one table row, without the outer pipes. */
function splitRow(line: string): Inline[][] {
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
  return cells.map((c) => parseInline(c.trim()));
}

const CODE_SPAN = /^(`+)([\s\S]*?)\1/;
const LINK = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
const IMAGE_INLINE = /^!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/;
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
export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  let i = 0;

  const flush = (): void => { if (text) { out.push({ t: "text", text }); text = ""; } };

  while (i < src.length) {
    const rest = src.slice(i);

    if (rest[0] === "\\" && rest.length > 1) { text += rest[1]; i += 2; continue; }

    const code = CODE_SPAN.exec(rest);
    if (code) { flush(); out.push({ t: "code", text: code[2]!.trim() }); i += code[0].length; continue; }

    // An inline image is rare and cannot be laid out inside a sentence, so it
    // reads as its alt text linked to the file — which is what a reader wants
    // from `![build status](…)` anyway.
    const img = IMAGE_INLINE.exec(rest);
    if (img) {
      flush();
      out.push({ t: "link", href: img[2]!, kids: [{ t: "text", text: img[1] || img[2]! }] });
      i += img[0].length;
      continue;
    }

    const link = LINK.exec(rest);
    if (link) {
      flush();
      out.push({ t: "link", href: link[2]!, kids: parseInline(link[1]!) });
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
    if (strong) { flush(); out.push({ t: "strong", kids: parseInline(strong[2]!) }); i += strong[0].length; continue; }

    const em = EM.exec(rest);
    if (em) { flush(); out.push({ t: "em", kids: parseInline(em[2]!) }); i += em[0].length; continue; }

    text += rest[0];
    i++;
  }

  flush();
  return out;
}

/** The plain text of a run of spans — for a row that has one line to give a
 *  thread, and for tests that care about what was kept rather than how. */
export function inlineText(kids: Inline[]): string {
  return kids.map((k) => (k.t === "text" || k.t === "code" ? k.text : inlineText(k.kids))).join("");
}
