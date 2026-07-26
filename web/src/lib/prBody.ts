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

/** A table cell is markdown too. Returning the raw text put `**Drift**` on
 *  screen with its asterisks — the bold that a RED/GREEN comparison leans on
 *  was exactly what stopped rendering. */
const cells = (l: string, repo?: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => renderInline(c.trim(), repo));
const isDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);
const IMG_MD = /^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/;
const IMG_HTML = /<img[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/i;

export function parseBody(body: string, autolinkRepo?: string): MdBlock[] {
  const out: MdBlock[] = [];
  const lines = (body || "").split(/\r?\n/);
  let para: string[] = [];

  const flushPara = () => {
    if (!para.length) return;
    out.push({ kind: "para", html: para.map((x) => renderInline(x, autolinkRepo)).join(" ") });
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // <details>: take everything up to the matching </details> and parse it as
    // its own little document, so a folded bot comment keeps its lists and code.
    const det = line.match(/^\s*<details[^>]*>\s*$/i);
    if (det) {
      flushPara();
      let summary = "";
      const inner: string[] = [];
      let depth = 1;
      i++;
      for (; i < lines.length; i++) {
        const l = lines[i]!;
        if (/^\s*<details[^>]*>\s*$/i.test(l)) depth++;
        if (/^\s*<\/details>\s*$/i.test(l)) { depth--; if (depth === 0) break; }
        const sum = l.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
        if (sum && !summary) { summary = stripTags(sum[1]!).trim(); continue; }
        inner.push(l);
      }
      out.push({ kind: "details", summary: summary || "Details", blocks: parseBody(inner.join("\n"), autolinkRepo) });
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
