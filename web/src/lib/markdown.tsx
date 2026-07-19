// Minimal markdown renderer for agent messages.
//
// Everything an agent writes is markdown — headings, **bold**, `code`, fenced
// blocks, lists — and rendering it as plain text meant reading the syntax
// instead of the content: literal asterisks, stray `##`, and code indentation
// collapsed into prose. That is fine for a preview and useless for a panel
// meant to replace the terminal you'd otherwise read it in.
//
// Hand-written rather than pulling in react-markdown + remark: this project
// keeps its dependency footprint deliberately small (see CONTRIBUTING), and the
// subset an agent actually emits is narrow.
//
// It returns React elements, never HTML strings — there is no
// dangerouslySetInnerHTML anywhere in here. Message text is untrusted (it can
// contain anything a model or a tool emitted), so it must never be able to
// become markup.
import type { ReactNode } from "react";

const CODE_BG = "color-mix(in srgb, var(--bg3) 55%, transparent)";

/** Inline spans: `code`, **bold**, *italic*, [text](url). Applied in one pass so
 *  a URL containing an underscore can't be mangled into italics. */
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-i${i++}`;
    if (tok.startsWith("`")) {
      out.push(<code key={k} className="px-1 py-0.5 rounded text-[0.92em]" style={{ background: CODE_BG, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      out.push(<strong key={k} style={{ color: "var(--text)" }}>{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={k}>{tok.slice(1, -1)}</em>);
    } else {
      const sep = tok.indexOf("](");
      const label = tok.slice(1, sep);
      const href = tok.slice(sep + 2, -1);
      // Only http(s): a message could otherwise carry javascript: or data:.
      const safe = /^https?:\/\//i.test(href);
      out.push(safe
        ? <a key={k} href={href} target="_blank" rel="noreferrer noopener" style={{ color: "var(--primary-hover)", textDecoration: "underline" }}>{label}</a>
        : <span key={k}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a markdown string as React nodes. Block level: fenced code, ATX
 *  headings, bullet and numbered lists, blockquotes, paragraphs. */
export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  const flushPara = (buf: string[]) => {
    if (!buf.length) return;
    blocks.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap break-words my-1.5 first:mt-0 last:mb-0">
        {inline(buf.join("\n"), `p${key}`)}
      </p>
    );
    buf.length = 0;
  };

  const para: string[] = [];
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code — taken verbatim, no inline parsing inside.
    const fence = line.match(/^\s*```(\w*)/);
    if (fence) {
      flushPara(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF — an unterminated block still renders)
      blocks.push(
        <pre key={`c${key++}`} className="my-2 p-2.5 rounded-lg overflow-x-auto text-[11.5px] leading-relaxed"
          style={{ background: CODE_BG, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>
          <code>{body.join("\n")}</code>
        </pre>
      );
      continue;
    }

    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) {
      flushPara(para);
      const lvl = head[1].length;
      blocks.push(
        <div key={`h${key++}`} className="font-semibold mt-3 mb-1 first:mt-0"
          style={{ color: "var(--text)", fontSize: lvl <= 2 ? "1.08em" : "1em" }}>
          {inline(head[2], `h${key}`)}
        </div>
      );
      i++;
      continue;
    }

    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const numbered = line.match(/^\s*(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(para);
      const items: { marker: string; text: string }[] = [];
      while (i < lines.length) {
        const b = lines[i].match(/^\s*[-*+]\s+(.*)$/);
        const n = lines[i].match(/^\s*(\d+)[.)]\s+(.*)$/);
        if (b) items.push({ marker: "•", text: b[1] });
        else if (n) items.push({ marker: `${n[1]}.`, text: n[2] });
        else break;
        i++;
      }
      blocks.push(
        <div key={`l${key++}`} className="my-1.5 flex flex-col gap-1">
          {items.map((it, n) => (
            <div key={n} className="flex gap-2">
              <span className="shrink-0 t-dim2 tabular-nums">{it.marker}</span>
              <span className="min-w-0 break-words">{inline(it.text, `l${key}-${n}`)}</span>
            </div>
          ))}
        </div>
      );
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushPara(para);
      const body: string[] = [];
      while (i < lines.length) {
        const q = lines[i].match(/^\s*>\s?(.*)$/);
        if (!q) break;
        body.push(q[1]);
        i++;
      }
      blocks.push(
        <div key={`q${key++}`} className="my-1.5 pl-2.5 border-l-2 whitespace-pre-wrap break-words"
          style={{ borderColor: "color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text2)" }}>
          {inline(body.join("\n"), `q${key}`)}
        </div>
      );
      continue;
    }

    if (!line.trim()) { flushPara(para); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara(para);

  return <>{blocks}</>;
}
