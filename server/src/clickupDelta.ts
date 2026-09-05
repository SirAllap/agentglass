/*
 * Markdown, as ClickUp's comment API actually wants it.
 *
 * A comment posted as `comment_text` is shown VERBATIM: the person reading the
 * card sees `**bold**` and `## heading`, asterisks and all. The same endpoint
 * renders properly when the body is an array of Delta ops instead — so every
 * formatted comment this app writes has to be converted first.
 *
 * The mapping below is not invented here. It comes from the work repo's own
 * `clickup-comment-markdown` skill, which verified each op against a real
 * workspace by posting it and reading the card back, and its four traps are the
 * whole reason this file exists rather than a `JSON.stringify` at the call site:
 *
 *   1. The content key is `text`, NOT `insert`. With `insert` the API answers
 *      200 with a comment id and the comment renders EMPTY.
 *   2. `attributes` must be present on every text op, even as `{}`.
 *   3. Every closing newline carries a `block-id`; ClickUp diffs blocks by it.
 *   4. Inside `table-embed` the key IS `insert` — the asymmetry is the API's.
 *
 * Anything this does not understand falls through as a plain paragraph, which
 * is the one failure mode worth having: the words arrive, unstyled.
 */

/** One op on the wire. Loose on purpose — a table op has no `text`. */
export type DeltaOp = Record<string, unknown>;

/**
 * Somebody who can be named, and everything a mention op carries about them.
 *
 * Read off a real comment written in ClickUp itself rather than guessed at:
 *
 *   { "type": "tag",
 *     "user": { "id": 38134814, "username": "Ada Lovelace",
 *               "email": "ada@orbit.test", "initials": "AL" },
 *     "text": "@Ada Lovelace" }
 *
 * Note what a tag op does NOT have: an `attributes` key. Every text op needs
 * one; this one is the exception, and the run after it carries the space.
 */
export type MentionPerson = { id: number; name: string; email?: string; initials?: string };

/** ClickUp's default when a fenced block names no language. Forwarded rather
 *  than guessed at: it is what the workspace itself assigns. */
const DEFAULT_CODE_LANG = "css";
const DEFAULT_COL_WIDTH = "238";

type Attrs = Record<string, unknown>;

/** Injected by the tests so the ops are comparable. Ten lowercase alphanumerics
 *  is the shape ClickUp writes itself. */
export type Rand = (n: number) => string;

const realRand: Rand = (n) => {
  let s = "";
  while (s.length < n) s += Math.random().toString(36).slice(2);
  return s.slice(0, n);
};

const op = (text: string, attrs: Attrs): DeltaOp => ({ text, attributes: { ...attrs } });

/** The `@` has to start a word: an address like `dev@orbit.test` is not
 *  somebody being called. Same rule the composer's menu uses. */
const opensMention = (text: string, at: number) => at === 0 || /\s|[([{]/.test(text[at - 1]!);

/**
 * A run of text, with anybody named in it lifted out into a mention.
 *
 * This is the difference between a comment that notifies and one that does not.
 * `@Name` as characters is just characters: the card shows what looks like a
 * mention, in the same colour as the rest of the sentence, and the person named
 * is never told — the worst shape a message can have, because the card says
 * somebody was told and they were not.
 *
 * Longest name first, so "@Ada Lovelace" is not matched as "@Ada" with a
 * surname left behind as text. Never inside code — `@Name` in a backticked run
 * is a string somebody is quoting, not a person being called.
 */
function textOps(text: string, attrs: Attrs, people: MentionPerson[]): DeltaOp[] {
  if (!text) return [];
  if (!people.length || attrs.code || !text.includes("@")) return [op(text, attrs)];
  const roster = [...people].sort((a, b) => b.name.length - a.name.length);
  const out: DeltaOp[] = [];
  let buf = "";
  let i = 0;
  while (i < text.length) {
    const at = text.indexOf("@", i);
    if (at === -1) { buf += text.slice(i); break; }
    buf += text.slice(i, at);
    const who = opensMention(text, at)
      ? roster.find((p) => text.slice(at + 1, at + 1 + p.name.length).toLowerCase() === p.name.toLowerCase())
      : undefined;
    if (!who) { buf += "@"; i = at + 1; continue; }
    if (buf) { out.push(op(buf, attrs)); buf = ""; }
    out.push({
      type: "tag",
      user: { id: who.id, username: who.name, ...(who.email ? { email: who.email } : null), ...(who.initials ? { initials: who.initials } : null) },
      text: `@${who.name}`,
    });
    i = at + 1 + who.name.length;
  }
  if (buf) out.push(op(buf, attrs));
  return out;
}

/* ---------------------------------------------------------------- inline --- */

/** The closing `*` of an italic run, skipping over any `**` on the way. */
function italicClose(text: string, from: number): number {
  let j = from;
  for (;;) {
    const at = text.indexOf("*", j);
    if (at === -1) return -1;
    if (text.slice(at, at + 2) === "**") { j = at + 2; continue; }
    return at;
  }
}

type Delim = { at: number; kind: "code" | "bold" | "strike" | "link" | "italic"; len: number };

function nextDelim(text: string, from: number): Delim | null {
  const found: Delim[] = [];
  for (const [kind, d] of [["code", "`"], ["bold", "**"], ["strike", "~~"], ["link", "["]] as const) {
    const at = text.indexOf(d, from);
    if (at !== -1) found.push({ at, kind, len: d.length });
  }
  // A lone `*`, which must not be half of a `**`.
  let j = from;
  for (;;) {
    const at = text.indexOf("*", j);
    if (at === -1) break;
    if (text.slice(at, at + 2) === "**") { j = at + 2; continue; }
    found.push({ at, kind: "italic", len: 1 });
    break;
  }
  if (!found.length) return null;
  return found.reduce((a, b) => (b.at < a.at ? b : a));
}

/**
 * Inline markdown to text ops.
 *
 * Recursive, so the attributes nest the way the syntax does: bold inside a
 * link, code inside bold. An unclosed delimiter is not an error — the
 * characters are kept as themselves, because a comment with a stray asterisk
 * should post with a stray asterisk rather than fail.
 */
export function parseInline(text: string, active: Attrs = {}, people: MentionPerson[] = []): DeltaOp[] {
  const ops: DeltaOp[] = [];
  let buf = "";
  let i = 0;
  const flush = () => { if (buf) { ops.push(...textOps(buf, active, people)); buf = ""; } };

  while (i < text.length) {
    const d = nextDelim(text, i);
    if (!d) { buf += text.slice(i); break; }
    buf += text.slice(i, d.at);

    if (d.kind === "code") {
      const end = text.indexOf("`", d.at + 1);
      if (end === -1) { buf += "`"; i = d.at + 1; continue; }
      flush();
      ops.push(op(text.slice(d.at + 1, end), { ...active, code: true }));
      i = end + 1;
    } else if (d.kind === "link") {
      const m = /^\[([^\]]+?)\]\(([^)]+?)\)/.exec(text.slice(d.at));
      if (!m) { buf += "["; i = d.at + 1; continue; }
      flush();
      ops.push(...parseInline(m[1]!, { ...active, link: m[2]! }, people));
      i = d.at + m[0].length;
    } else if (d.kind === "bold" || d.kind === "strike") {
      const mark = d.kind === "bold" ? "**" : "~~";
      const end = text.indexOf(mark, d.at + 2);
      if (end === -1) { buf += mark; i = d.at + 2; continue; }
      flush();
      ops.push(...parseInline(text.slice(d.at + 2, end), { ...active, [d.kind]: true }, people));
      i = end + 2;
    } else {
      const end = italicClose(text, d.at + 1);
      if (end === -1) { buf += "*"; i = d.at + 1; continue; }
      flush();
      ops.push(...parseInline(text.slice(d.at + 1, end), { ...active, italic: true }, people));
      i = end + 1;
    }
  }
  flush();
  return ops;
}

/* ----------------------------------------------------------------- blocks -- */

const LIST_RE = /^(\s*)([-*+]|\d+\.)\s+(.+)$/;
const HEADER_RE = /^(#{1,4})\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const FENCE_OPEN_RE = /^```(\S*)\s*$/;
const FENCE_CLOSE_RE = /^```\s*$/;
const TASK_RE = /^\[([ xX])\]\s+(.+)$/;
const TABLE_SEP_RE = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)+\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

/**
 * A markdown table as ClickUp's table embed.
 *
 * Note the key: `insert` inside the cells, against `text` everywhere else. That
 * is the API's own asymmetry and getting it the wrong way round is the
 * silent-empty failure again, one cell at a time.
 */
function buildTable(lines: string[], rand: Rand): DeltaOp {
  const header = splitRow(lines[0]!);
  const body = lines.slice(2).map(splitRow);
  const rows = [header, ...body];
  const cols = header.length;
  const cells: Record<string, unknown> = {};
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      cells[`${r + 1}:${c + 1}`] = {
        content: [{ insert: row[c] ?? "" }, { insert: "\n" }],
        attributes: { colspan: "1", rowspan: "1" },
      };
    }
  });
  return {
    type: "table-embed",
    "table-embed": {
      rows: rows.map(() => ({ insert: { id: `row-${rand(10)}` } })),
      columns: Array.from({ length: cols }, () => ({ insert: { id: `column-${rand(10)}` }, attributes: { width: DEFAULT_COL_WIDTH } })),
      cells,
    },
  };
}

/**
 * Markdown to the ops ClickUp renders.
 *
 * Pure: no network, no clock, and the randomness is a parameter — which is what
 * makes the mapping testable at all. The tests compare whole op arrays, because
 * every trap in this file is a key name and a key name is exactly what a
 * "does it roughly work" test misses.
 *
 * `people` is the roster anybody named in the text is looked up in. Empty by
 * default, which is the old behaviour exactly: no roster, no mentions, the `@`
 * stays a character.
 */
export function markdownToDelta(md: string, rand: Rand = realRand, people: MentionPerson[] = []): DeltaOp[] {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const ops: DeltaOp[] = [];
  const closeLine = (attrs: Attrs) => { ops.push({ text: "\n", attributes: { ...attrs, "block-id": `block-${rand(10)}` } }); };
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;
    const trimmed = line.trim();

    const fence = FENCE_OPEN_RE.exec(trimmed);
    if (fence) {
      const lang = fence[1] || DEFAULT_CODE_LANG;
      i++;
      // Each line of the block is its own op — a single multi-line insert
      // renders as one unbroken line.
      while (i < lines.length && !FENCE_CLOSE_RE.test(lines[i]!.trim())) {
        ops.push({ text: lines[i]!, attributes: {} });
        closeLine({ "code-block": { "code-block": lang } });
        i++;
      }
      if (i < lines.length) i++;
      continue;
    }

    if (trimmed === "---" || trimmed === "***" || trimmed === "___") {
      // The one op with no `attributes` at all, by the API's own shape.
      ops.push({ type: "divider", text: "---" });
      i++;
      continue;
    }

    if (trimmed.startsWith("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1]!.trim())) {
      const table: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) { table.push(lines[i]!); i++; }
      ops.push(buildTable(table, rand));
      continue;
    }

    const head = HEADER_RE.exec(trimmed);
    if (head) {
      ops.push(...parseInline(head[2]!, {}, people));
      closeLine({ header: head[1]!.length });
      i++;
      continue;
    }

    const quote = QUOTE_RE.exec(line);
    if (quote) {
      ops.push(...parseInline(quote[1]!, {}, people));
      // An empty object, not `true`: `blockquote: true` is accepted and drops
      // the styling.
      closeLine({ blockquote: {} });
      i++;
      continue;
    }

    const list = LIST_RE.exec(line);
    if (list) {
      const indent = Math.floor(list[1]!.length / 2);
      const task = TASK_RE.exec(list[3]!);
      const kind = task ? (task[1]!.toLowerCase() === "x" ? "checked" : "unchecked")
        : /\d/.test(list[2]![0]!) ? "ordered" : "bullet";
      ops.push(...parseInline(task ? task[2]! : list[3]!, {}, people));
      // Nested, not flat: `{ list: "bullet" }` posts and renders as a paragraph.
      closeLine(indent > 0 ? { list: { list: kind }, indent } : { list: { list: kind } });
      i++;
      continue;
    }

    if (!trimmed) { closeLine({}); i++; continue; }

    ops.push(...parseInline(line, {}, people));
    closeLine({});
    i++;
  }

  return ops;
}

/** True when the text has nothing for the converter to do — used to keep a
 *  one-line note a one-line note rather than a block structure. */
export function looksPlain(text: string): boolean {
  return !/[*_`~#>|]|^\s*\d+\.\s|^\s*[-+]\s|\[[^\]]+\]\([^)]+\)/m.test(text);
}
