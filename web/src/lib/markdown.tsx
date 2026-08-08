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
import { memo, type ReactNode } from "react";
import { externalUrl } from "./externalUrl.ts";
import { CodeBlock } from "./mdCode.tsx";

/* Mixed from --text rather than from a surface colour: --bg3 is a surface, and
   on the neutral themes it sits a hair from the panel behind it, so a chip
   built out of it is invisible. Mixing the text colour into transparent always
   moves away from the background, whichever way the theme runs. */
const CODE_BG = "color-mix(in srgb, var(--text) 13%, transparent)";
/*
 * Inline code, in an ink of its own.
 *
 * A grey chip on grey prose marks where a symbol is; it does not let you FIND
 * one. In a card that says `_validate_final_statement` eleven times, the names
 * are the argument, and a reader skimming for them was scanning character by
 * character. Every editor, GitHub and ClickUp all answer this the same way — a
 * warm, saturated ink — so the app should not be the one place that does not.
 *
 * Built from --error rather than from a colour of its own because that is the
 * only warm hue every one of the thirty themes defines, and it is defined to be
 * legible on that theme's background. Pulled towards --text so it reads as
 * emphasis rather than as an alarm.
 */
const CODE_INK = "color-mix(in srgb, var(--error) 78%, var(--text))";

/** Inline spans: `code`, **bold**, *italic*, [text](url). Applied in one pass so
 *  a URL containing an underscore can't be mangled into italics. */
function inline(text: string, keyBase: string, depth = 0): ReactNode[] {
  const out: ReactNode[] = [];
  // The image token comes FIRST, so `![](…)` is read as an image rather than as
  // a link with a stray `!` in front of it. Its alt may be empty — ClickUp
  // writes `![](url)` for a pasted screenshot, which is most of them — where a
  // link's label may not, because a link with no words is nothing to click.
  /*
   * The escape comes FIRST, so `\*` is one literal asterisk rather than the
   * opening of an emphasis run.
   *
   * It exists because something now GENERATES markdown for this renderer:
   * clickup.ts turns a comment's Quill delta into markdown, and a comment that
   * says `src/**` or names a glob would otherwise have its own text read as
   * formatting. A generator that cannot escape has no way to say "these
   * characters are literal", and the only alternative is dropping them.
   *
   * Only before ASCII punctuation, which is markdown's own rule — so a `\d` in
   * a regexp somebody pasted stays `\d` rather than becoming `d`.
   */
  const re = /(\\[!-/:-@[-`{-~])|(!\[[^\]\n]*\]\([^)\s]+\))|(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\*[^*\n]+\*)|(\[[^\]\n]+\]\([^)\s]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const k = `${keyBase}-i${i++}`;
    if (tok.length === 2 && tok.startsWith("\\")) {
      out.push(tok[1]);
    } else if (tok.startsWith("![")) {
      /*
       * A screenshot in a bug report is usually the report.
       *
       * These cards are half pictures — the messaging log, the page the defect
       * is on — and the panel was printing the markdown at them:
       * `![](https://…/image.png)`, forty characters of noise where the evidence
       * should be. Rendered inline now, and clickable, because the thing you do
       * with a screenshot of a log is look at it closely.
       *
       * Measured before building it: ClickUp's attachment URLs answer 200 with
       * no credentials, so this is an ordinary <img> and needs no proxy and no
       * token. Same `externalUrl` gate as a link — an <img> whose src is a
       * `javascript:` URL is not a thing, but the check costs nothing and there
       * is one answer in this app to "may a browser be handed this".
       */
      const sep = tok.indexOf("](");
      const alt = tok.slice(2, sep);
      const safe = externalUrl(tok.slice(sep + 2, -1));
      out.push(safe
        ? <a key={k} href={safe} target="_blank" rel="noreferrer noopener" className="block my-1.5">
            <img src={safe} alt={alt} loading="lazy"
              title={alt || "Open full size"}
              className="rounded-lg max-w-full h-auto"
              style={{ border: "1px solid color-mix(in srgb, var(--text) 14%, transparent)", maxHeight: 420, objectFit: "contain" }} />
          </a>
        // A picture we will not fetch is still worth naming — silently dropping
        // it would lose the fact that the card HAS one.
        : <span key={k} style={{ color: "var(--text4)" }}>{alt ? `[image: ${alt}]` : "[image]"}</span>);
    } else if (tok.startsWith("`")) {
      out.push(<code key={k} className="px-1 py-0.5 rounded text-[0.92em]" style={{ background: CODE_BG, color: CODE_INK, fontFamily: "var(--font-mono, ui-monospace, monospace)" }}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith("**")) {
      // Recursed, because emphasis nests: `**No \`service_specific\` flattening**`
      // is one bold run containing a symbol, and reading it as flat text put the
      // backticks on screen. Depth-capped so no pattern can make this recur
      // forever — two levels is every real case (bold around code, code is a
      // leaf) and the third is printed as it was written.
      out.push(<strong key={k} style={{ color: "var(--text)" }}>{depth < 2 ? inline(tok.slice(2, -2), k, depth + 1) : tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith("*")) {
      out.push(<em key={k}>{depth < 2 ? inline(tok.slice(1, -1), k, depth + 1) : tok.slice(1, -1)}</em>);
    } else {
      const sep = tok.indexOf("](");
      const label = tok.slice(1, sep);
      const href = tok.slice(sep + 2, -1);
      // Only http(s): a message could otherwise carry javascript: or data:.
      //
      // Asked of the URL parser rather than of a regexp, and asked through the
      // helper the pull request panel already uses, so there is one answer to
      // "is this safe to hand a browser" in the app instead of two that can
      // drift. The parser is also the stricter reader: it normalises away the
      // tab and newline tricks that hide a scheme from a pattern match, and it
      // refuses anything that is not an absolute URL at all.
      const safe = externalUrl(href);
      out.push(safe
        ? <a key={k} href={safe} target="_blank" rel="noreferrer noopener" style={{ color: "var(--primary-hover)", textDecoration: "underline" }}>{label}</a>
        : <span key={k}>{label}</span>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Render a markdown string as React nodes. Block level: fenced code, ATX
 *  headings, bullet and numbered lists, blockquotes, paragraphs.
 *
 *  Memoised on the text. A session view holds a few hundred kilobytes of
 *  messages and re-renders every few seconds while the session is live; parsing
 *  all of it again to produce identical output is the single most expensive
 *  thing that panel can do, and its one prop is a string, so the check is free.
 */
export const Markdown = memo(function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let key = 0;

  /*
   * The distance between two blocks, which is most of whether this is readable.
   *
   * It was 6px everywhere — a hairline — and the comparison that produced this
   * was a real automation comment beside GitHub's rendering of the same text:
   * a heading, its paragraph and the list under it arrived as one grey mass,
   * and the reader had to find where each severity band ended by reading it.
   * GitHub gives a paragraph a full line of air (16px on 14px text).
   *
   * 10px rather than 16 because this component is global and the narrow end is
   * the binding one. Checked at both: in a 320px column — the chat panel, and
   * the phone — a paragraph is two or three lines, so 10px is a clear break
   * between blocks without turning four findings into a scroll; at 16 the same
   * four findings gain most of a screen. In a wide document the numbers here
   * are not what renders at all: `.agx-prose` in index.css sets its own 0.85em
   * on p and on the list, and a class utility loses to it, so the document
   * viewer keeps the rhythm it was tuned to.
   *
   * The ladder the blocks below are spaced on, all of it in the same units:
   * item-to-item 6 · paragraph 10 · code 12 · heading 16 above · rule 16.
   */
  const flushPara = (buf: string[]) => {
    if (!buf.length) return;
    blocks.push(
      <p key={`p${key++}`} className="whitespace-pre-wrap break-words my-2.5 first:mt-0 last:mb-0">
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
        <CodeBlock key={`c${key++}`} code={body.join("\n")} tag={fence[1]}
          className="agx-scroll my-3 p-3 rounded-lg overflow-x-auto text-[11.5px] leading-relaxed"
          style={{
            background: CODE_BG, fontFamily: "var(--font-mono, ui-monospace, monospace)",
            // A hairline, so a block that ends where the prose resumes has a
            // bottom edge. On the darker themes CODE_BG alone barely separates.
            border: "1px solid color-mix(in srgb, var(--text) 9%, transparent)",
          }} />
      );
      continue;
    }

    // `---` on its own line. A card that separates its sections with a rule
    // means it; printing three dashes at the reader loses the one piece of
    // structure the author put there by hand.
    if (/^\s*([-*_])\s*\1\s*\1[\s-*_]*$/.test(line) && !para.length) {
      flushPara(para);
      blocks.push(<hr key={`r${key++}`} className="my-4 border-0" style={{ borderTop: "1px solid color-mix(in srgb, var(--text) 12%, transparent)" }} />);
      i++;
      continue;
    }

    const head = line.match(/^(#{1,4})\s+(.*)$/);
    if (head) {
      flushPara(para);
      // A real heading element, not a bold div. It is what it is — assistive
      // technology can move by it and a surface can style its own scale — and
      // the card panel's stylesheet was already written against h1..h3 and
      // silently matching nothing.
      const H = (["h1", "h2", "h3", "h4"] as const)[head[1].length - 1];
      /*
       * The size is a variable the SURFACE sets, not a number decided here.
       *
       * It was inline — 1.08em for h1 and h2, 1em for the rest — which is right
       * for an agent's three-line answer in a panel and flat as a board in a
       * document, where the heading level is how you navigate. And an inline
       * style beats every stylesheet, so a surface that wanted its own scale
       * could not have one however it asked: measured in the document viewer,
       * h1 and h2 both came out at 15px against 14px of body text.
       *
       * The fallback used to be 1.08em for h1 and h2 and 1em for the rest, on
       * the argument that it kept every existing surface rendering as it did.
       * What it actually kept was a heading that did not read as one: an
       * `### MEDIUM` over its findings came out at exactly the size of the
       * prose under it, bold — and against a paragraph that opens in bold
       * itself, which is how these comments are written, bold is not a signal.
       * Measured against GitHub's rendering of the same comment side by side:
       * theirs read as three severity bands, ours as one column of text.
       *
       * So the fallback is a ladder now. It stays BELOW `.agx-prose`'s scale
       * (1.85 / 1.4 / 1.15 / 1) on purpose: that one is for a document, where
       * the heading level is how you navigate a page of it, and this one is for
       * an answer in a panel, where an h1 at 1.85em is a banner over three
       * lines. h4 is 1em in both — the smallest heading earns its weight from
       * being bold and from the air above it, not from a size nobody can see.
       */
      const lvl = head[1].length;
      blocks.push(
        /* mt-4/mb-1.5, and the asymmetry is the point: the space belongs ABOVE
           the heading, so it separates the section that ended from the one
           starting, and the heading stays tied to the block it introduces. Even
           spacing makes a heading float between two sections and belong to
           neither. `first:mt-0` keeps a message that opens with one flush. */
        <H key={`h${key++}`} className="font-semibold mt-4 mb-1.5 first:mt-0"
          style={{ color: "var(--text)", fontSize: `var(--agx-md-h${lvl}, ${[1.45, 1.25, 1.1, 1][lvl - 1]}em)` }}>
          {inline(head[2], `h${key}`)}
        </H>
      );
      i++;
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    const numbered = line.match(/^(\s*)(\d+)[.)]\s+(.*)$/);
    if (bullet || numbered) {
      flushPara(para);
      /*
       * Nesting, and the lines that belong to an item without starting one.
       *
       * Both were thrown away: `^\s*` matched the indent and dropped it, so a
       * sub-list came out at the same level as its parent — and a wrapped line
       * under an item was not consumed at all, so it became a paragraph of its
       * own and the list restarted after it. In an agent's three-bullet answer
       * neither shows; in a document with a numbered procedure and sub-points
       * under step 4, the structure is the content.
       */
      const items: { indent: number; marker: string; text: string }[] = [];
      /*
       * A blank line between items does not end the list.
       *
       * Markdown calls this a "loose" list and it is what anything that writes
       * a report writes — a blank line between findings is how a machine keeps
       * them apart. The loop stopped at the first one, so a four-item list with
       * air in it came out as FOUR separate `<ul>`s; and because depth is
       * worked out from the distinct indents present in the list being built, a
       * sub-list that landed in a `<ul>` of its own had exactly one indent,
       * which is therefore its zero. Both nested items rendered flush against
       * their parent. Measured on a fixture of that shape: four lists, five
       * items, `margin-left: 0` on every one of them — the nesting the author
       * typed was on screen as no nesting at all.
       *
       * Only another ITEM may reach across the gap. A paragraph after a list is
       * a paragraph, and a heading is the next section — so the look-ahead
       * skips blanks and then asks what it found, rather than assuming.
       */
      const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;
      let loose = false;
      while (i < lines.length) {
        const b = lines[i].match(/^(\s*)[-*+]\s+(.*)$/);
        const n = lines[i].match(/^(\s*)(\d+)[.)]\s+(.*)$/);
        if (b) { items.push({ indent: b[1].length, marker: "•", text: b[2] }); i++; }
        else if (n) { items.push({ indent: n[1].length, marker: `${n[2]}.`, text: n[3] }); i++; }
        else if (items.length && lines[i].trim() && /^\s/.test(lines[i])) {
          // Indented and not a new item: a continuation of the one above.
          items[items.length - 1]!.text += `\n${lines[i].trim()}`;
          i++;
        } else if (items.length && !lines[i].trim()) {
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          if (j >= lines.length || !ITEM.test(lines[j])) break;
          loose = true;
          i = j;
        } else break;
      }
      // Indentation in a document is whatever the author's editor used — two
      // spaces, four, a tab expanded to eight. So depth comes from the ORDER of
      // the distinct indents present, not from dividing by a number nobody
      // agreed on.
      /*
       * Depth from a STACK of open indents, not from the position of this
       * item's indent in the sorted set of all of them.
       *
       * `indexOf` filed a four-space sublist a level below a two-space one, so
       * a document that indents some sublists by two and some by four — which
       * is most of them — nested the second inside the first. Measured on
       * `- a / __- b / - c / ____- d`: margins 0, 22, 0, 44, where GitHub draws
       * b and d at the same level. What matters is only whether an item is
       * further in than the one it follows, never by how much.
       */
      const open: number[] = [];
      const level = items.map((it) => {
        while (open.length && it.indent < open[open.length - 1]!) open.pop();
        if (!open.length || it.indent > open[open.length - 1]!) open.push(it.indent);
        return Math.min(4, open.length - 1);
      });
      blocks.push(
        // A list the author wrote with air in it keeps it: the gap between
        // items is what said "these are separate findings", and collapsing a
        // loose list onto a tight one throws away the one thing its shape meant.
        <ul key={`l${key++}`} className={`agx-md-list my-2.5 first:mt-0 last:mb-0 flex flex-col ${loose ? "gap-2" : "gap-1.5"} list-none p-0`}>
          {items.map((it, n) => (
            <li key={n} className="flex gap-2" style={{ marginLeft: level[n]! * 22 }}>
              {/* `t-dim` (--text3), not `t-dim2` (--text4). --text4 is the
                  palette's dimmest tier, floored at 4:1 by floorTiers — the
                  budget for a timestamp in the corner of a tile. A bullet is
                  not metadata: it is the mark the reader counts the items by,
                  and at 4.1:1 on the default theme it was a smudge where GitHub
                  draws a dot. --text3 is floored at 5:1 and measures 6.2:1 there. */}
              <span className="shrink-0 t-dim tabular-nums">{it.marker}</span>
              <span className="min-w-0 break-words whitespace-pre-wrap">{inline(it.text, `l${key}-${n}`)}</span>
            </li>
          ))}
        </ul>
      );
      continue;
    }

    // GFM table: a header row, a |---|:--:|---| separator, then body rows.
    // Requires the separator, so a line that merely contains pipes (a shell
    // pipeline, an `A | B` type union) is left as prose.
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      flushPara(para);
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const header = cells(line);
      // ":---" / ":--:" / "---:" carry the column alignment.
      const align = cells(lines[i + 1]).map((s) =>
        s.startsWith(":") && s.endsWith(":") ? "center" : s.endsWith(":") ? "right" : "left" as const);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      const cellStyle = (n: number) => ({
        textAlign: (align[n] ?? "left") as "left" | "right" | "center",
        borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
      });
      blocks.push(
        // Scrolls on its own rather than widening the bubble: a wide table must
        // not force the whole conversation into a horizontal scroll.
        <div key={`t${key++}`} className="my-2 overflow-x-auto agx-scroll">
          <table className="text-[0.95em]" style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                {header.map((h, n) => (
                  <th key={n} className="px-2.5 py-1.5 font-semibold whitespace-nowrap"
                    style={{ textAlign: (align[n] ?? "left") as "left" | "right" | "center", color: "var(--text)" }}>
                    {inline(h, `th${key}-${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>
                  {r.map((c, n) => (
                    <td key={n} className="px-2.5 py-1.5 align-top" style={cellStyle(n)}>{inline(c, `td${key}-${ri}-${n}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
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
        /* A real <blockquote>, for the same reason the heading above is a real
           heading: it is what it is, assistive technology can move by it, and a
           surface can style its own. index.css already carried
           `.agx-prose blockquote { margin: 1em 0 }` — written against an element
           this renderer never emitted, so it had been matching nothing. */
        <blockquote key={`q${key++}`} className="my-2.5 first:mt-0 last:mb-0 pl-2.5 border-l-2 whitespace-pre-wrap break-words"
          style={{ borderColor: "color-mix(in srgb, var(--primary) 45%, transparent)", color: "var(--text2)" }}>
          {inline(body.join("\n"), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    if (!line.trim()) { flushPara(para); i++; continue; }
    para.push(line);
    i++;
  }
  flushPara(para);

  return <>{blocks}</>;
});
