/*
 * The desktop and the phone read the same bodies. They draw them differently
 * (HTML there, native views here) and parse them separately, so the one thing
 * that can silently drift is WHAT THEY THINK THE BODY IS: a fold the phone
 * calls a paragraph, a table it reads as two. This feeds the same documents to
 * both parsers and compares the shape they find — the kinds of block, the
 * cells of a table, the summary of a fold, the address of a picture — and
 * nothing about how it looks.
 *
 * The documents are the shapes of real bot output and real descriptions.
 */
import { describe, expect, test } from "bun:test";
import { parseBody, stripTags, type MdBlock } from "../../web/src/lib/prBody.ts";
import { inlineText, parseMarkdown, type Block } from "../src/md/parse.ts";

const KIND: Record<MdBlock["kind"], Block["t"] | null> = {
  heading: "h", para: "p", list: "list", code: "code", table: "table", quote: "quote",
  image: "image", details: "details", rule: "hr", alert: null, suggestion: null,
};

/** What the desktop found, in the phone's words. */
function desktop(blocks: MdBlock[]): unknown[] {
  return blocks.map((b) => {
    const t = KIND[b.kind];
    if (b.kind === "table") return { t, head: b.head.map(stripTags), rows: b.rows.map((r) => r.map(stripTags)) };
    if (b.kind === "details") return { t, summary: b.summary, inside: desktop(b.blocks) };
    if (b.kind === "image") return { t, src: b.src, alt: b.alt };
    if (b.kind === "heading") return { t, level: b.level, text: stripTags(b.html) };
    if (b.kind === "code") return { t, text: b.text };
    if (b.kind === "list") return { t, items: b.items.length };
    return { t };
  });
}

function phone(blocks: Block[]): unknown[] {
  return blocks.map((b) => {
    if (b.t === "table") return { t: b.t, head: b.head.map(inlineText), rows: b.rows.map((r) => r.map(inlineText)) };
    if (b.t === "details") return { t: b.t, summary: b.summary, inside: phone(b.blocks) };
    if (b.t === "image") return { t: b.t, src: b.src, alt: b.alt };
    if (b.t === "h") return { t: b.t, level: b.level, text: inlineText(b.kids) };
    if (b.t === "code") return { t: b.t, text: b.text };
    if (b.t === "list") return { t: b.t, items: b.items.length };
    return { t: b.t };
  });
}

const both = (src: string) => ({ desktop: desktop(parseBody(src)), phone: phone(parseMarkdown(src)) });
const md = (...lines: string[]): string => lines.join("\n");

const DOCS: Record<string, string> = {
  "a description with a checklist": md(
    "## Summary", "Adds a retry to the sync client.", "",
    "## Checklist", "- [x] tests", "- [ ] docs", "- [ ] changelog", "",
    "```ts", "retry(3)", "```", "", "---", "", "> note to reviewers",
  ),
  "a coverage bot: a fold, then an HTML table on one line": md(
    "<details><summary>Coverage report</summary>", "",
    "<table><tr><th>File</th><th>Cover</th></tr><tr><td><b>a.ts</b></td><td>91%</td></tr><tr><td>b.ts</td><td>40%</td></tr></table>",
    "", "</details>",
  ),
  "a pasted screenshot, and one written in Markdown": md(
    "Before:", "", '<img width="640" alt="before" src="https://github.com/user-attachments/assets/aaaa" />', "",
    "![after](https://github.com/user-attachments/assets/bbbb)",
  ),
  "a pipe table with a sentence before it": md(
    "Results:", "", "| case | ms |", "| --- | --- |", "| cold | 120 |", "| warm | 18 |",
  ),
  "two folds, one with a list and code inside": md(
    "<details>", "<summary>Logs</summary>", "", "- first", "- second", "", "```", "boom", "```", "", "</details>", "",
    "<details><summary>More</summary>tail</details>",
  ),
  "an unclosed fold owns the rest": md("Intro", "", "<details><summary>Open</summary>", "", "everything after"),
};

describe("the desktop and the phone find the same shape", () => {
  for (const [name, src] of Object.entries(DOCS)) {
    test(name, () => {
      const got = both(src);
      expect(got.phone.length).toBeGreaterThan(0); // two empty answers agree too
      expect(got.phone).toEqual(got.desktop);
    });
  }
});
