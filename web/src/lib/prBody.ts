// The pure text logic behind the pull-request panel: a PR body is markdown, and
// `gh pr diff` returns the whole request in one blob.
//
// Kept out of the component so it can be tested without a DOM — the panel
// imports `api.ts`, which reads `location` while its module body runs.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderInline(s: string): string {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code class="px-1 rounded" style="background:color-mix(in srgb,var(--border) 30%,transparent)">$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:var(--text)">$1</strong>');
  // Links only to http(s) — a markdown link is a place to smuggle javascript:.
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    (_m, text: string, href: string) => `<a href="${href}" target="_blank" rel="noreferrer noopener" style="color:var(--primary)">${text}</a>`);
  out = out.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_m, pre: string, href: string) => `${pre}<a href="${href}" target="_blank" rel="noreferrer noopener" style="color:var(--primary)">${href}</a>`);
  return out;
}

export type MdBlock =
  | { kind: "text"; html: string }
  | { kind: "code"; text: string }
  | { kind: "image"; src: string; alt: string }
  /** A real table, not the pipes. PR bodies use these for before/after
   *  evidence — a RED/GREEN comparison is a table, and rendering it as raw
   *  pipes is the difference between reading the proof and squinting at it. */
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "quote"; html: string };

/** Split a body into what has to render differently: fenced code, images
 *  (which need the proxy), and everything else. */
export function parseBody(body: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (!buf.length) return;
    const html = buf.map((line) => {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) return `<div style="color:var(--text);font-weight:600;margin-top:.7em">${renderInline(h[2]!)}</div>`;
      const task = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (task) {
        const done = task[1]!.toLowerCase() === "x";
        return `<div style="display:flex;gap:.4em;color:${done ? "var(--text3)" : "var(--text)"}">` +
          `<span style="color:${done ? "var(--success)" : "var(--warning)"}">${done ? "✔" : "☐"}</span>` +
          `<span>${renderInline(task[2]!)}</span></div>`;
      }
      const li = line.match(/^\s*[-*]\s+(.*)$/);
      if (li) return `<div style="display:flex;gap:.4em"><span style="color:var(--primary)">·</span><span>${renderInline(li[1]!)}</span></div>`;
      if (!line.trim()) return "<div style='height:.5em'></div>";
      return `<div>${renderInline(line)}</div>`;
    }).join("");
    blocks.push({ kind: "text", html });
    buf = [];
  };

  // `\r?\n`, not `\n`: GitHub bodies are CRLF, and a JS regex `.` matches
  // neither `\n` nor `\r`, so every `(.*)$` rule below silently fails on a line
  // that still carries its carriage return — headings, task boxes and images
  // all render as plain text.
  const lines = (body || "").split(/\r?\n/);
  let fence: string[] | null = null;

  /** `| a | b |` -> ["a","b"], tolerating the optional outer pipes. */
  const cells = (l: string) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  const isDivider = (l: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().startsWith("```")) {
      if (fence) { blocks.push({ kind: "code", text: fence.join("\n") }); fence = null; }
      else { flush(); fence = []; }
      continue;
    }
    if (fence) { fence.push(line); continue; }

    // A table is a header row, a divider, then rows — checked ahead rather
    // than line by line, because a lone `|` line is not a table.
    if (line.includes("|") && i + 1 < lines.length && isDivider(lines[i + 1]!)) {
      flush();
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.includes("|") && lines[i]!.trim()) { rows.push(cells(lines[i]!)); i++; }
      i--;
      blocks.push({ kind: "table", head, rows });
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i]!)) { quoted.push(lines[i]!.replace(/^\s*>\s?/, "")); i++; }
      i--;
      blocks.push({ kind: "quote", html: quoted.map((q) => `<div>${renderInline(q)}</div>`).join("") });
      continue;
    }

    const md = line.match(/^\s*!\[([^\]]*)\]\((https?:\/\/[^\s)]+)\)\s*$/);
    const html = line.match(/<img[^>]*\bsrc="(https?:\/\/[^"]+)"[^>]*>/i);
    if (md) { flush(); blocks.push({ kind: "image", src: md[2]!, alt: md[1]! }); continue; }
    if (html) {
      flush();
      const alt = line.match(/\balt="([^"]*)"/i)?.[1] ?? "";
      blocks.push({ kind: "image", src: html[1]!, alt });
      continue;
    }
    buf.push(line);
  }
  if (fence) blocks.push({ kind: "code", text: fence.join("\n") });
  flush();
  return blocks;
}

// ---------------------------------------------------------------------------
// diffs
// ---------------------------------------------------------------------------

/**
 * One unified diff, cut into per-file pieces.
 *
 * `gh pr diff` returns the whole pull request in one blob, and dumping that
 * under the file list is how you get a review nobody can navigate. One fetch
 * still, sliced here, so picking a file is instant and costs nothing.
 */
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
      // The b-side name: a rename shows its destination, which is the path the
      // file list is keyed by.
      path = m[2]!;
      buf = [line];
      continue;
    }
    if (path) buf.push(line);
  }
  flush();
  return out;
}

export const lineTint = (l: string): string =>
  l.startsWith("+") && !l.startsWith("+++") ? "var(--success)"
    : l.startsWith("-") && !l.startsWith("---") ? "var(--error)"
    : l.startsWith("@@") ? "var(--primary)"
    : l.startsWith("diff --git") || l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") ? "var(--text3)"
    : "var(--text2)";
