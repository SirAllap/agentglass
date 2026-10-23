/*
 * A Jira comment's text, in and out: Markdown on our side, Atlassian Document
 * Format (ADF) on Jira Cloud's REST v3, wiki markup on Data Center's v2.
 *
 * Which one a site speaks is the connection's (`api`, detected at connect
 * time), never guessed from the text. Writes go Markdown -> ADF on v3 and
 * Markdown -> ADF -> wiki on v2, so there is one Markdown reader; reads go
 * ADF -> Markdown or wiki -> Markdown for the card's own renderer.
 *
 * Contract, both directions: paragraphs, headings, bold, italic, inline code,
 * strike, links, bullet and numbered lists (nested), code blocks, quotes,
 * rules, hard breaks, tables, and mentions. A mention keeps the person's id
 * (`attrs.id` on Cloud, the login name in `[~name]` on Data Center): reading
 * one gives `@Name` in the text plus `{id, name}` beside it, and writing `@Name`
 * becomes a mention only for a person in the roster the caller passes, so a
 * typed `@` with nobody behind it stays a character.
 *
 * Ceiling, on purpose: panels, expands, media, emoji, cards, dates, statuses
 * and task lists are read as their text (a panel as a quote, media as
 * "(attachment)"); underline, colour, sub/superscript are dropped; a node this
 * does not know is read as the text inside it. Nothing here throws on what a
 * site sends. Bold and italic on the same words read as bold, because the
 * renderer has no nesting. Wiki formatting in the middle of a word (`a*b*c`)
 * is not written in the `{*}` form, and a line that starts `h1.` or `bq.` in
 * plain text is not escaped.
 */

export interface Mention { id: string; name: string }
export interface AdfNode { type: string; attrs?: Record<string, unknown>; content?: AdfNode[]; text?: string; marks?: AdfMark[] }
export interface AdfMark { type: string; attrs?: Record<string, unknown> }
export interface AdfDoc { type: "doc"; version: 1; content: AdfNode[] }
export interface ReadText { text: string; mentions: Mention[] }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const MAX_MENTIONS = 50;
/** A Cloud account id (`5b10a2844c20165700ede21g`, `712020:2b6e...`). */
export const ACCOUNT_ID = /^[A-Za-z0-9:._-]{1,128}$/;
/** A Data Center login, as it goes inside `[~name]`. */
export const LOGIN = /^[^\s[\]|~{}]{1,255}$/;

/** The people a comment names, as the caller sent them; anything malformed is dropped. */
export function readMentions(raw: unknown, v: 2 | 3): Mention[] {
  if (!Array.isArray(raw)) return [];
  const out: Mention[] = [];
  for (const m of raw.slice(0, MAX_MENTIONS)) {
    if (!isObj(m)) continue;
    const id = str(m.id), name = str(m.name).trim();
    if (!(v === 3 ? ACCOUNT_ID : LOGIN).test(id) || !name || name.length > 100 || /[\n\r]/.test(name)) continue;
    out.push({ id, name });
  }
  return out;
}

/** Only a link a reader can follow safely is kept as a link. */
const SAFE_URL = /^(?:https?:\/\/|mailto:)[^\s<>"'`]+$/i;

// ===========================================================================
// Markdown -> ADF
// ===========================================================================

type Marks = AdfMark[];
const hasMark = (ms: Marks, t: string) => ms.some((m) => m.type === t);
const withMark = (ms: Marks, m: AdfMark): Marks => (hasMark(ms, m.type) ? ms : [...ms, m]);

function textNode(text: string, marks: Marks): AdfNode | null {
  if (!text) return null;
  // ADF allows `code` only beside `link`.
  const ms = hasMark(marks, "code") ? marks.filter((m) => m.type === "code" || m.type === "link") : marks;
  return ms.length ? { type: "text", text, marks: ms.map((m) => ({ ...m })) } : { type: "text", text };
}

const sameMarks = (a?: Marks, b?: Marks) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);

/** Neighbouring runs with the same marks become one, the way Jira writes them. */
function merge(nodes: AdfNode[]): AdfNode[] {
  const out: AdfNode[] = [];
  for (const n of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && n.type === "text" && sameMarks(prev.marks, n.marks)) prev.text = (prev.text ?? "") + (n.text ?? "");
    else out.push(n);
  }
  return out;
}

const isWord = (c: string | undefined) => !!c && /[\p{L}\p{N}]/u.test(c);
const opensMention = (s: string, at: number) => at === 0 || /[\s([{]/.test(s[at - 1]!);
const ASCII_PUNCT = /[!-/:-@[-`{-~]/;

/** Where the closing delimiter is, on the same line, with something between. */
function closer(s: string, from: number, delim: string): number {
  const j = s.indexOf(delim, from);
  if (j > from && s.slice(from, j).includes("\n")) return -1;
  return j > from ? j : -1;
}

function inlineMd(s: string, marks: Marks, roster: Mention[]): AdfNode[] {
  const out: AdfNode[] = [];
  let buf = "";
  const flush = () => { const n = textNode(buf, marks); if (n) out.push(n); buf = ""; };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && ASCII_PUNCT.test(s[i + 1]!)) { buf += s[i + 1]; i += 2; continue; }
    if (c === "\n") { flush(); out.push({ type: "hardBreak" }); i++; continue; }
    if (c === "`") {
      const j = closer(s, i + 1, "`");
      if (j > 0) { flush(); const n = textNode(s.slice(i + 1, j), withMark(marks, { type: "code" })); if (n) out.push(n); i = j + 1; continue; }
    }
    if (s.startsWith("**", i)) {
      const j = closer(s, i + 2, "**");
      if (j > 0) { flush(); out.push(...inlineMd(s.slice(i + 2, j), withMark(marks, { type: "strong" }), roster)); i = j + 2; continue; }
    }
    if (s.startsWith("~~", i)) {
      const j = closer(s, i + 2, "~~");
      if (j > 0) { flush(); out.push(...inlineMd(s.slice(i + 2, j), withMark(marks, { type: "strike" }), roster)); i = j + 2; continue; }
    }
    if (c === "*" && s[i + 1] !== " ") {
      const j = closer(s, i + 1, "*");
      if (j > 0 && s[j - 1] !== " ") { flush(); out.push(...inlineMd(s.slice(i + 1, j), withMark(marks, { type: "em" }), roster)); i = j + 1; continue; }
    }
    if (c === "[") {
      const m = /^\[([^\]\n]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/.exec(s.slice(i));
      if (m && SAFE_URL.test(m[2]!)) {
        flush();
        out.push(...inlineMd(m[1]!, withMark(marks, { type: "link", attrs: { href: m[2] } }), roster));
        i += m[0].length;
        continue;
      }
    }
    if (c === "h" && !hasMark(marks, "link") && (i === 0 || !/[\w/]/.test(s[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>()[\]`"']+/.exec(s.slice(i));
      if (m) {
        const url = m[0].replace(/[.,;:!?]+$/, "");
        flush();
        const n = textNode(url, withMark(marks, { type: "link", attrs: { href: url } }));
        if (n) out.push(n);
        i += url.length;
        continue;
      }
    }
    if (c === "@" && roster.length && !hasMark(marks, "code") && opensMention(s, i)) {
      // Longest name first, so "@Ada Example" is not taken as "@Ada".
      const who = [...roster].sort((a, b) => b.name.length - a.name.length)
        .find((p) => s.slice(i + 1, i + 1 + p.name.length).toLowerCase() === p.name.toLowerCase() && !isWord(s[i + 1 + p.name.length]));
      if (who) {
        flush();
        out.push({ type: "mention", attrs: { id: who.id, text: `@${who.name}` } });
        i += 1 + who.name.length;
        continue;
      }
    }
    buf += c;
    i++;
  }
  flush();
  return merge(out);
}

const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
/** Matched on the trimmed line, so no backtracking across a run of spaces; a
 *  closing `#` run counts only after a space (`# C#` is a heading "C#"). */
const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const headingOf = (line: string): [string, string] | null => {
  if (/^\s{4}/.test(line)) return null;
  const m = HEADING_RE.exec(line.trim());
  if (!m) return null;
  // Not `/\s+#+$/`: on a line of spaces that pattern is quadratic.
  let t = m[2]!.trimEnd();
  const k = t.search(/#+$/);
  if (k === 0) t = "";
  else if (k > 0 && /\s/.test(t[k - 1]!)) t = t.slice(0, k).trimEnd();
  return [m[1]!, t.trim()];
};
const RULE = /^\s{0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/;
const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|(?:\s*:?-{1,}:?\s*\|)+\s*$/;

const indentOf = (line: string) => /^\s*/.exec(line)![0].replace(/\t/g, "    ").length;
const isBlank = (l: string) => !l.trim();

function cells(row: string): string[] {
  const inner = row.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === "\\" && inner[i + 1] === "|") { cur += "|"; i++; continue; }
    if (inner[i] === "|") { out.push(cur.trim()); cur = ""; continue; }
    cur += inner[i];
  }
  out.push(cur.trim());
  return out;
}

/** Does this line start a block other than a paragraph? */
const startsBlock = (l: string) => FENCE.test(l) || !!headingOf(l) || RULE.test(l) || ITEM.test(l) || QUOTE.test(l) || TABLE_ROW.test(l);

function para(lines: string[], roster: Mention[]): AdfNode | null {
  const content = inlineMd(lines.map((l) => l.trim()).join("\n"), [], roster);
  return content.length ? { type: "paragraph", content } : null;
}

function blocksMd(lines: string[], roster: Mention[], depth = 0): AdfNode[] {
  const out: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const close = fence[1]!;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i]!.trim().startsWith(close[0]!.repeat(close.length)) && /^\s*[`~]+\s*$/.test(lines[i]!))) body.push(lines[i++]!);
      i++; // the closing fence, or the end
      const text = body.join("\n");
      out.push({ type: "codeBlock", ...(fence[2] ? { attrs: { language: fence[2] } } : {}), ...(text ? { content: [{ type: "text", text }] } : {}) });
      continue;
    }
    const h = headingOf(line);
    if (h) {
      const content = inlineMd(h[1], [], roster);
      out.push({ type: "heading", attrs: { level: h[0].length }, ...(content.length ? { content } : {}) });
      i++;
      continue;
    }
    if (RULE.test(line)) { out.push({ type: "rule" }); i++; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i]!)) body.push(QUOTE.exec(lines[i++]!)![1]!);
      const inner = depth < 8 ? fitInside(blocksMd(body, roster, depth + 1)) : flat(body, roster);
      if (inner.length) out.push({ type: "blockquote", content: inner });
      continue;
    }
    if (TABLE_ROW.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && TABLE_ROW.test(lines[i]!)) rows.push(lines[i++]!);
      const header = rows.length > 1 && TABLE_SEP.test(rows[1]!);
      const body = rows.filter((r, n) => !(header && n === 1));
      const cell = (text: string, head: boolean): AdfNode => {
        const content = inlineMd(text, [], roster);
        return { type: head ? "tableHeader" : "tableCell", attrs: {}, content: [content.length ? { type: "paragraph", content } : { type: "paragraph" }] };
      };
      out.push({
        type: "table",
        attrs: { isNumberColumnEnabled: false, layout: "default" },
        content: body.map((r, n) => ({ type: "tableRow", content: cells(r).map((c) => cell(c, header && n === 0)) })),
      });
      continue;
    }
    const item = ITEM.exec(line);
    if (item) {
      const [list, next] = listMd(lines, i, roster, depth);
      out.push(list);
      i = next;
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && !isBlank(lines[i]!) && (buf.length === 0 || !startsBlock(lines[i]!))) buf.push(lines[i++]!);
    const p = para(buf, roster);
    if (p) out.push(p);
  }
  return out;
}

/**
 * What a list item or a quote may hold: Jira refuses a document with a
 * heading, a rule, a table or a quote inside one, so those are flattened.
 */
function fitInside(nodes: AdfNode[]): AdfNode[] {
  return nodes.flatMap((n): AdfNode[] => {
    if (n.type === "heading") return [n.content?.length ? { type: "paragraph", content: n.content } : { type: "paragraph" }];
    if (n.type === "rule") return [];
    if (n.type === "blockquote") return fitInside(n.content ?? []);
    if (n.type === "table") {
      return (n.content ?? []).map((row) => {
        const content = (row.content ?? []).flatMap((cell, k) => [
          ...(k ? [{ type: "text", text: " | " }] : []),
          ...(cell.content ?? []).flatMap((b) => b.content ?? []),
        ]);
        return content.length ? { type: "paragraph", content: merge(content) } : { type: "paragraph" };
      });
    }
    return [n];
  });
}

/** Past the nesting cap, what is left is kept as words rather than dropped. */
function flat(lines: string[], roster: Mention[]): AdfNode[] {
  const p = para(lines.filter((l) => !isBlank(l)), roster);
  return p ? [p] : [];
}

/** Is a fence open at the end of these lines (so the next line is code)? */
function openFence(lines: string[]): boolean {
  let open: string | null = null;
  for (const l of lines) {
    const f = FENCE.exec(l);
    if (!f) continue;
    if (!open) open = f[1]!;
    else if (!f[2] && f[1]![0] === open[0] && f[1]!.length >= open.length) open = null;
  }
  return open !== null;
}

/** One list from line `start`, and the line after it. Nested lists are the
 *  lines indented past an item's marker. */
function listMd(lines: string[], start: number, roster: Mention[], depth: number): [AdfNode, number] {
  const first = ITEM.exec(lines[start]!)!;
  const ordered = /\d/.test(first[2]!);
  const base = indentOf(lines[start]!);
  const items: AdfNode[] = [];
  let i = start;
  while (i < lines.length) {
    const m = ITEM.exec(lines[i]!);
    if (!m || indentOf(lines[i]!) !== base || /\d/.test(m[2]!) !== ordered) break;
    const contentAt = base + m[2]!.length + 1;
    const body: string[] = [m[3]!];
    i++;
    while (i < lines.length) {
      const l = lines[i]!;
      if (isBlank(l)) {
        // A blank line ends the item unless the next line is still inside it.
        const after = lines[i + 1];
        if (after !== undefined && !isBlank(after) && indentOf(after) > base) { body.push(""); i++; continue; }
        break;
      }
      if (openFence(body)) { body.push(l.slice(Math.min(indentOf(l), contentAt))); i++; continue; }
      if (indentOf(l) > base) { body.push(l.slice(Math.min(indentOf(l), contentAt))); i++; continue; }
      // A lazy continuation: a plain line right under the item's text.
      if (!startsBlock(l) && !isBlank(body[body.length - 1] ?? "")) { body.push(l); i++; continue; }
      break;
    }
    const inner = depth < 8 ? fitInside(blocksMd(body, roster, depth + 1)) : flat(body, roster);
    // An item opens with a paragraph, even an empty one, before a nested list or code.
    if (inner[0]?.type !== "paragraph") inner.unshift({ type: "paragraph" });
    items.push({ type: "listItem", content: inner });
    // A blank line between two items of the same list does not end it.
    if (i < lines.length && isBlank(lines[i]!) && lines[i + 1] && ITEM.test(lines[i + 1]!) && indentOf(lines[i + 1]!) === base) i++;
  }
  const order = ordered ? Number(/\d+/.exec(first[2]!)![0]) : 1;
  return [{ type: ordered ? "orderedList" : "bulletList", ...(ordered && order !== 1 ? { attrs: { order } } : {}), content: items }, i];
}

/** Markdown as a Jira Cloud document. `roster` is who `@Name` may mean. */
export function markdownToAdf(md: string, roster: Mention[] = []): AdfDoc {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  return { type: "doc", version: 1, content: blocksMd(lines, roster.filter((p) => p.name)) };
}

// ===========================================================================
// ADF -> Markdown
// ===========================================================================

/** Characters our Markdown reader (and the card's renderer) would read as syntax. */
function escMd(s: string): string {
  return s.replace(/[\\`*[\]~]/g, "\\$&");
}
/** A pipe inside a table cell. `cells` reads every `\|` as a pipe and hands
 *  any other backslash to the inline reader untouched, so the pipe is the one
 *  character a cell adds an escape for: a backslash already escaped by `escMd`
 *  (or kept verbatim in code) comes back as it went. */
const escCellPipes = (s: string) => s.split("|").join("\\|");
/** A paragraph line that would read as another block is escaped at its start. */
function escLineStart(line: string): string {
  if (/^\s*(?:#{1,6}\s|>|[-+]\s|\d{1,9}[.)]\s|\|)/.test(line)) return line.replace(/^(\s*)(\d{1,9})?([#>+\-.)|])/, (_m, sp: string, d: string | undefined, ch: string) => `${sp}${d ?? ""}\\${ch}`);
  if (/^\s*(?:-{3,}|_{3,})\s*$/.test(line)) return line.replace(/^(\s*)(.)/, "$1\\$2");
  return line;
}

interface MdCtx { mentions: Mention[] }

function mentionName(n: AdfNode): string {
  const a = isObj(n.attrs) ? n.attrs : {};
  const raw = str(a.text) || str(a.displayName) || str(a.id);
  return raw.replace(/^@/, "") || "someone";
}

function plainOf(n: AdfNode, cx: MdCtx, depth = 0): string {
  if (!isObj(n) || depth > 64) return "";
  const a = isObj(n.attrs) ? n.attrs : {};
  switch (n.type) {
    case "text": return str(n.text);
    case "hardBreak": return "\n";
    case "mention": {
      const name = mentionName(n);
      if (str(a.id)) cx.mentions.push({ id: str(a.id), name });
      return `@${name}`;
    }
    case "emoji": return str(a.text) || str(a.shortName);
    case "inlineCard": case "blockCard": case "embedCard": return str(a.url);
    case "date": { const t = Number(str(a.timestamp) || a.timestamp); return Number.isFinite(t) && t > 0 ? new Date(t).toISOString().slice(0, 10) : ""; }
    case "status": return str(a.text);
    case "media": case "mediaInline": return str(a.alt) || "(attachment)";
    default: return Array.isArray(n.content) ? n.content.map((c) => plainOf(c, cx, depth + 1)).join("") : str(n.text);
  }
}

/** One inline node as Markdown, marks and all. */
function inlineNodeMd(n: AdfNode, cx: MdCtx): string {
  if (n.type !== "text") {
    const t = plainOf(n, cx);
    if (n.type === "mention") return t;
    if ((n.type === "inlineCard" || n.type === "blockCard" || n.type === "embedCard") && SAFE_URL.test(t)) return t;
    return escMd(t);
  }
  const marks = Array.isArray(n.marks) ? n.marks.filter(isObj) : [];
  const has = (t: string) => marks.some((m) => m.type === t);
  let t = str(n.text);
  if (!t) return "";
  if (has("code")) {
    // A backtick inside a code span would close it; the run is cut there.
    t = "`" + t.replace(/`/g, "'") + "`";
  } else {
    t = escMd(t);
    // Spaces stay outside the markers, or `** x **` is not bold to anybody.
    const lead = /^\s*/.exec(t)![0];
    const trail = t.length > lead.length ? /\s*$/.exec(t)![0] : "";
    let core = t.slice(lead.length, t.length - trail.length);
    if (core) {
      if (has("strike")) core = `~~${core}~~`;
      // No nesting in the renderer: bold wins over italic.
      if (has("strong")) core = `**${core}**`;
      else if (has("em")) core = `*${core}*`;
    }
    t = lead + core + trail;
  }
  const link = marks.find((m) => m.type === "link");
  const href = link && isObj(link.attrs) ? str(link.attrs.href) : "";
  return href && SAFE_URL.test(href) ? `[${t}](${href})` : t;
}

function inlineMdOf(nodes: AdfNode[] | undefined, cx: MdCtx): string {
  if (!Array.isArray(nodes)) return "";
  // Neighbours under the same link are one link.
  const out: string[] = [];
  let k = 0;
  while (k < nodes.length) {
    const n = nodes[k]!;
    const href = linkOf(n);
    if (href && SAFE_URL.test(href)) {
      let j = k;
      const inner: string[] = [];
      while (j < nodes.length && linkOf(nodes[j]!) === href) { inner.push(inlineNodeMd(stripLink(nodes[j]!), cx)); j++; }
      out.push(`[${inner.join("")}](${href})`);
      k = j;
      continue;
    }
    out.push(isObj(n) ? inlineNodeMd(n, cx) : "");
    k++;
  }
  return out.join("");
}

function linkOf(n: AdfNode): string {
  if (!isObj(n) || n.type !== "text" || !Array.isArray(n.marks)) return "";
  const l = n.marks.find((m) => isObj(m) && m.type === "link");
  return l && isObj(l.attrs) ? str(l.attrs.href) : "";
}
const stripLink = (n: AdfNode): AdfNode => ({ ...n, marks: (n.marks ?? []).filter((m) => m.type !== "link") });

const INLINE = new Set(["text", "hardBreak", "mention", "emoji", "inlineCard", "date", "status", "mediaInline", "placeholder"]);

const indentLines = (s: string, pad: string, firstPad = pad) => s.split("\n").map((l, i) => (l ? (i ? pad : firstPad) + l : l)).join("\n");

function blockMd(n: AdfNode, cx: MdCtx, depth: number): string {
  if (!isObj(n) || depth > 12) return "";
  const a = isObj(n.attrs) ? n.attrs : {};
  const kids = Array.isArray(n.content) ? n.content : [];
  switch (n.type) {
    case "paragraph": return inlineMdOf(kids, cx).split("\n").map(escLineStart).join("\n");
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(a.level) || 1));
      return `${"#".repeat(level)} ${inlineMdOf(kids, cx).replace(/\n/g, " ")}`;
    }
    case "codeBlock": {
      const lang = /^[\w+#.-]{1,32}$/.test(str(a.language)) ? str(a.language) : "";
      const body = kids.map((c) => plainOf(c, cx)).join("");
      const fence = /```/.test(body) ? "~~~~" : "```";
      return `${fence}${lang}\n${body}\n${fence}`;
    }
    case "rule": return "---";
    case "blockquote": case "panel":
      return blocksMdOf(kids, cx, depth + 1).split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n");
    case "bulletList": case "orderedList": case "taskList": case "decisionList": {
      const start = n.type === "orderedList" ? Math.max(0, Math.floor(Number(a.order) || 1)) : 1;
      return kids.map((item, k) => {
        const marker = n.type === "orderedList" ? `${start + k}. `
          : n.type === "taskList" ? `- [${isObj(item.attrs) && item.attrs.state === "DONE" ? "x" : " "}] ` : "- ";
        const itemKids = Array.isArray(item?.content) ? item.content : [];
        // A task item holds inline nodes directly.
        const body = item?.type === "taskItem" || item?.type === "decisionItem"
          ? inlineMdOf(itemKids, cx)
          : itemKids.map((c) => blockMd(c, cx, depth + 1)).filter((s) => s !== "").join("\n");
        return indentLines(body || "", " ".repeat(marker.length), marker) || marker.trimEnd();
      }).join("\n");
    }
    case "table": {
      const rows = kids.filter((r) => isObj(r) && Array.isArray(r.content)).map((r) =>
        r.content!.map((c) => blocksMdOf(Array.isArray(c?.content) ? c.content : [], cx, depth + 1).replace(/\n+/g, " ")).map(escCellPipes));
      if (!rows.length) return "";
      const width = Math.max(...rows.map((r) => r.length));
      const line = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? "").join(" | ")} |`;
      return [line(rows[0]!), `|${" --- |".repeat(width)}`, ...rows.slice(1).map(line)].join("\n");
    }
    case "expand": case "nestedExpand": {
      const title = str(a.title);
      const body = blocksMdOf(kids, cx, depth + 1);
      return title ? `**${escMd(title)}**${body ? `\n\n${body}` : ""}` : body;
    }
    case "mediaSingle": case "mediaGroup": return kids.map((c) => plainOf(c, cx) || "(attachment)").join(" ") || "(attachment)";
    default: {
      // An unknown block: its blocks if it holds blocks, else its words.
      if (kids.length && kids.every((c) => isObj(c) && !INLINE.has(c.type))) return blocksMdOf(kids, cx, depth + 1);
      return kids.length ? inlineMdOf(kids, cx) : escMd(plainOf(n, cx));
    }
  }
}

function blocksMdOf(nodes: AdfNode[], cx: MdCtx, depth: number): string {
  return nodes.map((n) => blockMd(n, cx, depth)).filter((s) => s !== "").join("\n\n");
}

/** A Jira Cloud document as Markdown, with the people it mentions. Never throws. */
export function adfToMarkdown(doc: unknown): ReadText {
  const cx: MdCtx = { mentions: [] };
  if (typeof doc === "string") return { text: doc, mentions: [] };
  if (!isObj(doc) || !Array.isArray(doc.content)) return { text: "", mentions: [] };
  try {
    return { text: blocksMdOf(doc.content as AdfNode[], cx, 0), mentions: dedupe(cx.mentions) };
  } catch {
    return { text: plainOf(doc as unknown as AdfNode, { mentions: [] }), mentions: [] };
  }
}

function dedupe(ms: Mention[]): Mention[] {
  const seen = new Set<string>();
  return ms.filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
}

// ===========================================================================
// ADF -> wiki markup (Data Center writes)
// ===========================================================================

const WIKI_STRUCT = /[{}[\]|\\]/;
const WIKI_EFFECT = /[*_\-+^~?!]/;

/** Plain text, with whatever wiki markup would read as syntax escaped. Effect
 *  characters only matter where a run could open or close, at a word edge. */
function escWiki(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (WIKI_STRUCT.test(c) || (WIKI_EFFECT.test(c) && !(isWord(s[i - 1]) && isWord(s[i + 1])))) out += "\\" + c;
    else out += c;
  }
  return out;
}

/** Monospace text: a brace would close `{{...}}` early, and a backslash
 *  would escape the brace that closes it, so both are escaped. */
const escWikiCode = (s: string) => s.replace(/[{}\\]/g, "\\$&");

const WIKI_NAME = /^[^\s[\]|~{}]{1,255}$/;

function inlineWiki(nodes: AdfNode[] | undefined): string {
  if (!Array.isArray(nodes)) return "";
  return nodes.map((n) => {
    if (n.type === "hardBreak") return "\n";
    if (n.type === "mention") {
      const id = str(n.attrs?.id);
      return WIKI_NAME.test(id) ? `[~${id}]` : escWiki(str(n.attrs?.text));
    }
    if (n.type !== "text") return escWiki(str(n.text));
    const marks = n.marks ?? [];
    const has = (t: string) => marks.some((m) => m.type === t);
    let t = str(n.text);
    if (!t) return "";
    if (has("code")) t = `{{${escWikiCode(t)}}}`;
    else {
      t = escWiki(t);
      const lead = /^\s*/.exec(t)![0];
      const trail = t.length > lead.length ? /\s*$/.exec(t)![0] : "";
      let core = t.slice(lead.length, t.length - trail.length);
      if (core) {
        if (has("strike")) core = `-${core}-`;
        if (has("em")) core = `_${core}_`;
        if (has("strong")) core = `*${core}*`;
      }
      t = lead + core + trail;
    }
    const href = str(marks.find((m) => m.type === "link")?.attrs?.href);
    if (href && SAFE_URL.test(href) && !/[|\]]/.test(href)) return t === escWiki(href) ? `[${href}]` : `[${t}|${href}]`;
    return t;
  }).join("");
}

function blockWiki(n: AdfNode, prefix: string, depth: number): string {
  const kids = n.content ?? [];
  switch (n.type) {
    case "paragraph": return inlineWiki(kids).split("\n").map((l) => (/^\s*#/.test(l) ? l.replace("#", "\\#") : l)).join("\n");
    case "heading": return `h${Math.min(6, Math.max(1, Number(n.attrs?.level) || 1))}. ${inlineWiki(kids).replace(/\n/g, " ")}`;
    case "codeBlock": {
      const lang = str(n.attrs?.language);
      const body = kids.map((c) => str(c.text)).join("");
      return `{code${/^[a-z0-9+#-]{1,32}$/i.test(lang) ? `:${lang}` : ""}}\n${body}\n{code}`;
    }
    case "rule": return "----";
    case "blockquote": return `{quote}\n${kids.map((c) => blockWiki(c, "", depth + 1)).join("\n\n")}\n{quote}`;
    case "bulletList": case "orderedList": {
      const mark = prefix + (n.type === "orderedList" ? "#" : "*");
      return kids.map((item) => {
        // An item's words are its line; a nested list follows as its own lines.
        const head: string[] = [];
        const nested: string[] = [];
        for (const c of item.content ?? []) {
          if (c.type.endsWith("List")) nested.push(blockWiki(c, mark, depth + 1));
          // A wiki list item is one line: its code goes in as inline code.
          else if (c.type === "codeBlock") head.push(`{{${escWikiCode((c.content ?? []).map((t) => str(t.text)).join(" ").replace(/\n/g, " "))}}}`);
          else head.push(blockWiki(c, "", depth + 1).replace(/\n/g, " "));
        }
        return [`${mark} ${head.join(" ")}`, ...nested].join("\n");
      }).join("\n");
    }
    case "table":
      return kids.map((row) => {
        const cellsW = (row.content ?? []).map((c) => ({ head: c.type === "tableHeader", text: (c.content ?? []).map((p) => blockWiki(p, "", depth + 1)).join(" ").replace(/\n/g, " ") }));
        return cellsW.map((c) => (c.head ? `||${c.text}` : `|${c.text}`)).join("") + (cellsW.at(-1)?.head ? "||" : "|");
      }).join("\n");
    default: return inlineWiki(kids);
  }
}

/** A document as Data Center wiki markup. Fed only what `markdownToAdf` makes. */
export function adfToWiki(doc: AdfDoc): string {
  return doc.content.map((n) => blockWiki(n, "", 0)).filter(Boolean).join("\n\n");
}

/** Markdown as Data Center wiki markup; `roster` ids are login names there. */
export function markdownToWiki(md: string, roster: Mention[] = []): string {
  return adfToWiki(markdownToAdf(md, roster));
}

// ===========================================================================
// wiki markup -> Markdown (Data Center reads)
// ===========================================================================

/**
 * Wiki text as Markdown. `names` turns a login in `[~ada]` into the name a
 * person is shown by, when the same answer carried it (a comment's author);
 * a login nobody named is shown as it is. Never throws.
 */
export function wikiToMarkdown(wiki: unknown, names: Record<string, string> = {}): ReadText {
  if (typeof wiki !== "string") return { text: "", mentions: [] };
  const mentions: Mention[] = [];
  try {
    return { text: wikiBlocks(wiki.replace(/\r\n?/g, "\n").split("\n"), names, mentions, 0), mentions: dedupe(mentions) };
  } catch {
    return { text: escMd(wiki), mentions: [] };
  }
}

function wikiBlocks(lines: string[], names: Record<string, string>, mentions: Mention[], depth: number): string {
  const out: string[] = [];
  let i = 0;
  const inl = (s: string) => wikiInline(s, names, mentions, 0);
  while (i < lines.length) {
    const line = lines[i]!;
    if (!line.trim()) { i++; continue; }
    const code = /^\s*\{(code|noformat)(?::([^}]*))?\}(.*)$/.exec(line);
    if (code) {
      const tag = code[1]!;
      const lang = (code[2] ?? "").split("|").find((p) => /^[\w+#.-]{1,32}$/.test(p)) ?? "";
      const body: string[] = [];
      let rest = code[3]!;
      const endTag = `{${tag}}`;
      for (;;) {
        const at = rest.indexOf(endTag);
        if (at >= 0) { if (rest.slice(0, at)) body.push(rest.slice(0, at)); break; }
        if (rest || body.length) body.push(rest);
        i++;
        if (i >= lines.length) break;
        rest = lines[i]!;
      }
      i++;
      const text = body.join("\n").replace(/^\n+|\n+$/g, "");
      const fence = /```/.test(text) ? "~~~~" : "```";
      out.push(`${fence}${lang}\n${text}\n${fence}`);
      continue;
    }
    if (/^\s*\{quote\}/.test(line)) {
      const body: string[] = [];
      let rest = line.replace(/^\s*\{quote\}/, "");
      for (;;) {
        const at = rest.indexOf("{quote}");
        if (at >= 0) { body.push(rest.slice(0, at)); break; }
        body.push(rest);
        i++;
        if (i >= lines.length) break;
        rest = lines[i]!;
      }
      i++;
      const inner = depth < 8 ? wikiBlocks(body, names, mentions, depth + 1) : "";
      if (inner) out.push(inner.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
      continue;
    }
    const h = /^\s*h([1-6])\.\s+(.*)$/.exec(line);
    if (h) { out.push(`${"#".repeat(Number(h[1]))} ${inl(h[2]!)}`); i++; continue; }
    const bq = /^\s*bq\.\s+(.*)$/.exec(line);
    if (bq) { out.push(`> ${inl(bq[1]!)}`); i++; continue; }
    if (/^\s*-{4,}\s*$/.test(line)) { out.push("---"); i++; continue; }
    if (/^\s*\|/.test(line)) {
      const rows: { head: boolean; cells: string[] }[] = [];
      while (i < lines.length && /^\s*\|/.test(lines[i]!)) {
        const l = lines[i++]!.trim();
        const head = l.startsWith("||");
        const parts = l.replace(/^\|\|?/, "").replace(/\|\|?$/, "").split(/\|\|?/).map((c) => escCellPipes(inl(c.trim())));
        rows.push({ head, cells: parts });
      }
      const width = Math.max(...rows.map((r) => r.cells.length));
      const line2 = (r: string[]) => `| ${Array.from({ length: width }, (_, k) => r[k] ?? "").join(" | ")} |`;
      const md = [line2(rows[0]!.cells), `|${" --- |".repeat(width)}`, ...rows.slice(1).map((r) => line2(r.cells))];
      out.push(md.join("\n"));
      continue;
    }
    if (/^\s*[*#-]+\s+\S/.test(line) && !/^\s*-{4,}/.test(line)) {
      const items: string[] = [];
      const counters: number[] = [];
      while (i < lines.length && /^\s*[*#-]+\s+\S/.test(lines[i]!)) {
        const m = /^\s*([*#-]+)\s+(.*)$/.exec(lines[i++]!)!;
        const marks = m[1]!;
        const depthL = marks.length;
        counters.length = depthL;
        let pad = "";
        for (let d = 0; d < depthL - 1; d++) pad += marks[d] === "#" ? "   " : "  ";
        const ordered = marks[depthL - 1] === "#";
        counters[depthL - 1] = (counters[depthL - 1] ?? 0) + 1;
        items.push(`${pad}${ordered ? `${counters[depthL - 1]}. ` : "- "}${inl(m[2]!)}`);
      }
      out.push(items.join("\n"));
      continue;
    }
    const buf: string[] = [];
    while (i < lines.length && lines[i]!.trim() && !/^\s*(?:\{(?:code|noformat|quote)|h[1-6]\.\s|bq\.\s|-{4,}\s*$|\||[*#-]+\s+\S)/.test(lines[i]!)) buf.push(lines[i++]!);
    if (!buf.length) { buf.push(lines[i++]!); }
    out.push(buf.map((l) => escLineStart(inl(l.trim()))).join("\n"));
  }
  return out.join("\n\n");
}

/** Wiki effects that wrap a run: the marker, and what it becomes. */
const EFFECTS: [string, (s: string) => string][] = [
  ["*", (s) => `**${s}**`],
  ["_", (s) => `*${s}*`],
  ["-", (s) => `~~${s}~~`],
  ["??", (s) => `*${s}*`],
  ["+", (s) => s],
  ["^", (s) => s],
  ["~", (s) => s],
];

function wikiInline(s: string, names: Record<string, string>, mentions: Mention[], depth: number): string {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) { out += escMd(s[i + 1]!); i += 2; continue; }
    if (s.startsWith("{{", i)) {
      // The first `}}` that is not an escaped brace closes it.
      let j = i + 2;
      while (j < s.length && !s.startsWith("}}", j)) j += s[j] === "\\" ? 2 : 1;
      if (j >= s.length) j = -1;
      if (j > i + 2) { out += "`" + s.slice(i + 2, j).replace(/\\([{}\\])/g, "$1").replace(/`/g, "'") + "`"; i = j + 2; continue; }
    }
    if (c === "{") {
      // {color:red}, {color}, {anchor:x}: dropped, the words between them kept.
      const m = /^\{(?:color(?::[^}]*)?|anchor:[^}]*|\*|_|-|\+)\}/.exec(s.slice(i));
      if (m) { i += m[0].length; continue; }
    }
    if (c === "[") {
      const j = s.indexOf("]", i + 1);
      if (j > i) {
        const inner = s.slice(i + 1, j);
        if (inner.startsWith("~")) {
          const login = inner.slice(1);
          if (WIKI_NAME.test(login)) {
            const name = names[login] || login;
            mentions.push({ id: login, name });
            out += `@${name}`;
            i = j + 1;
            continue;
          }
        }
        const bar = inner.lastIndexOf("|");
        const href = (bar >= 0 ? inner.slice(bar + 1) : inner).trim();
        if (SAFE_URL.test(href)) {
          const label = bar >= 0 ? inner.slice(0, bar) : "";
          out += label ? `[${depth < 4 ? wikiInline(label, names, mentions, depth + 1) : escMd(label)}](${href})` : href;
          i = j + 1;
          continue;
        }
      }
    }
    if (c === "!") {
      const m = /^!([^\s!|]+\.[A-Za-z0-9]{2,5})(?:\|[^!]*)?!/.exec(s.slice(i));
      if (m) { out += "(attachment)"; i += m[0].length; continue; }
    }
    if (c === "h" && (i === 0 || !/[\w/]/.test(s[i - 1]!))) {
      const m = /^https?:\/\/[^\s<>()[\]`"'|]+/.exec(s.slice(i));
      if (m) { out += m[0]; i += m[0].length; continue; }
    }
    let took = false;
    for (const [mk, wrap] of EFFECTS) {
      if (!s.startsWith(mk, i) || isWord(s[i - 1]) || /\s/.test(s[i + mk.length] ?? " ")) continue;
      // The closing marker: not after a space, not before a letter.
      let j = s.indexOf(mk, i + mk.length + 1);
      while (j > 0 && (/\s/.test(s[j - 1]!) || isWord(s[j + mk.length]))) j = s.indexOf(mk, j + 1);
      if (j < 0) continue;
      const inner = s.slice(i + mk.length, j);
      out += wrap(depth < 4 ? wikiInline(inner, names, mentions, depth + 1) : escMd(inner));
      i = j + mk.length;
      took = true;
      break;
    }
    if (took) continue;
    out += escMd(c);
    i++;
  }
  return out;
}

// ===========================================================================
// Whether a stored description can be edited as Markdown without losing any of it
// ===========================================================================

/** What Markdown holds and writes back as it was: the nodes and marks `markdownToAdf` makes, less tables. */
const KEPT_NODES = new Set(["paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "rule", "blockquote", "text", "hardBreak", "mention"]);
const KEPT_MARKS = new Set(["strong", "em", "code", "strike", "link"]);

/** A node as the round trip must give it back: the attributes Markdown carries, neighbouring runs of one kind joined. */
function canon(n: AdfNode): unknown {
  const a = isObj(n.attrs) ? n.attrs : {};
  const attrs: Record<string, unknown> =
    n.type === "heading" ? { level: a.level }
    : n.type === "codeBlock" ? { language: str(a.language) }
    : n.type === "orderedList" ? { order: Number(a.order) || 1 }
    : n.type === "mention" ? { id: a.id }
    : {};
  const marks = (n.marks ?? []).map((m) => ({ type: m.type, ...(m.type === "link" ? { href: isObj(m.attrs) ? m.attrs.href : "" } : null) }))
    .sort((x, y) => x.type.localeCompare(y.type));
  const kids: unknown[] = [];
  for (const k of (n.content ?? []).map(canon)) {
    const prev = kids[kids.length - 1] as { type?: string; text?: string; marks?: unknown } | undefined;
    const me = k as { type?: string; text?: string; marks?: unknown };
    if (prev && prev.type === "text" && me.type === "text" && JSON.stringify(prev.marks) === JSON.stringify(me.marks)) prev.text = (prev.text ?? "") + (me.text ?? "");
    else kids.push(k);
  }
  return { type: n.type, attrs, ...(n.type === "text" ? { text: n.text ?? "", marks } : { content: kids }) };
}

function onlyKept(n: unknown, depth: number): boolean {
  if (!isObj(n) || depth > 12 || !KEPT_NODES.has(str(n.type))) return false;
  if (Array.isArray(n.marks) && !n.marks.every((m) => isObj(m) && KEPT_MARKS.has(str(m.type)))) return false;
  return (Array.isArray(n.content) ? n.content : []).every((k) => onlyKept(k, depth + 1));
}

/**
 * Whether a stored description survives Markdown both ways: every node and
 * mark in it is one Markdown holds, and reading it as Markdown and writing that
 * back gives the same document. A panel, a table, media, an expand, a task list,
 * an emoji, a smart link, a colour or an underline fails it, and the pane then
 * says so and sends the person to Jira instead of flattening the page.
 * Empty is editable. Data Center's wiki text is held to the same round trip as text.
 *
 * Ceiling: the round trip is judged on structure (kind, level, language, link
 * address, mention id, marks) and on words; ids Jira puts on a node and the
 * attributes of a table or a panel are not compared, which is why those never pass.
 */
export function editableBody(body: unknown, v: 2 | 3): boolean {
  if (body == null || body === "") return true;
  if (v === 2) {
    // A table's cells are not Markdown's to keep, as on Cloud, even where the text happens to come back.
    if (typeof body !== "string" || /^\s*\|/m.test(body)) return false;
    const now = wikiToMarkdown(body);
    const flat = (s: string) => s.replace(/\r\n?/g, "\n").trim();
    return flat(markdownToWiki(now.text, now.mentions)) === flat(body);
  }
  if (!isObj(body) || body.type !== "doc" || !Array.isArray(body.content)) return false;
  if (!body.content.every((n) => onlyKept(n, 0))) return false;
  const now = adfToMarkdown(body);
  const back = markdownToAdf(now.text, now.mentions);
  return JSON.stringify((body.content as AdfNode[]).map(canon)) === JSON.stringify(back.content.map(canon));
}
