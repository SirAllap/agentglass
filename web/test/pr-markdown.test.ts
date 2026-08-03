// The markdown a pull request is actually written in.
//
// Each case here is something that turned up in a real body or bot comment and
// rendered wrong: a folded <details> that came through as escaped tags, a
// GitHub callout that read as a quote, `#123` that stayed plain text, `:tada:`
// as punctuation. The escaping tests are the ones with teeth — a body is a
// string a stranger wrote.
import { describe, expect, test } from "bun:test";
import { parseBody, renderInline, stripTags, diffKind, type MdBlock } from "../src/lib/prBody.ts";

/** Everything a tree of blocks would put on screen, flattened. What the
 *  `<details>` tests want to assert is mostly about where text ended up — inside
 *  the fold, outside it, or leaked through as escaped tags. */
function allText(blocks: MdBlock[]): string {
  return blocks.map((b) => {
    if (b.kind === "details") return `${b.summary}\n${allText(b.blocks)}`;
    if (b.kind === "list") return b.items.map((i) => i.html).join("\n");
    if (b.kind === "table") return [...b.head, ...b.rows.flat()].join("\n");
    if (b.kind === "code" || b.kind === "suggestion") return b.text;
    return "html" in b ? b.html : "";
  }).join("\n");
}

describe("<details>", () => {
  test("folds into a details block, with its summary and its inner markdown", () => {
    const blocks = parseBody([
      "<details>",
      "<summary>Coverage report</summary>",
      "",
      "- lines: 91%",
      "- branches: 84%",
      "</details>",
    ].join("\n"));
    expect(blocks).toHaveLength(1);
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).toBe("Coverage report");
    // The body is parsed, not dumped: a list inside stays a list.
    expect(d.blocks.some((b) => b.kind === "list")).toBe(true);
  });

  test("a missing summary still renders, with a name of its own", () => {
    const blocks = parseBody("<details>\n\nplain\n</details>");
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).toBe("Details");
  });

  test("nested details close at the right place", () => {
    const blocks = parseBody([
      "<details>",
      "<summary>outer</summary>",
      "<details>",
      "<summary>inner</summary>",
      "deep",
      "</details>",
      "outer tail",
      "</details>",
      "after",
    ].join("\n"));
    // Two blocks: the details, then the paragraph that follows it. If the
    // nesting were mishandled, "after" would be swallowed.
    expect(blocks[0]!.kind).toBe("details");
    expect(blocks[blocks.length - 1]!.kind).toBe("para");
  });

  // Every case below is a shape the old "the tag sits alone on its line" rule
  // could not see. They are not exotic: the first is the form GitHub documents,
  // and it arrived from a real pull request body as three paragraphs of escaped
  // tags with the payload permanently unfolded.
  test("the opener and its summary on one line — the form GitHub documents", () => {
    const blocks = parseBody([
      "<details><summary><b>Full 200 payload (FE mock)</b></summary>",
      "",
      "```json",
      '{ "eligibility": "self_serve" }',
      "```",
      "",
      "</details>",
      "",
      "Notes: the allowance is locally shrunk.",
    ].join("\n"));
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    // The markup around the title is taken off, as it is for a summary of its own.
    expect(d.summary).toBe("Full 200 payload (FE mock)");
    expect(d.blocks.some((b) => b.kind === "code")).toBe(true);
    // The prose after the fold stays outside it, and no tag reaches the screen.
    expect(blocks[blocks.length - 1]!.kind).toBe("para");
    expect(allText(blocks)).toContain("locally shrunk");
    expect(allText(blocks)).not.toContain("&lt;details");
    expect(allText(blocks)).not.toContain("&lt;/details");
    expect(allText(blocks)).not.toContain("&lt;summary");
  });

  test("attributes on the opener change nothing — <details open> still folds", () => {
    const blocks = parseBody('<details open class="x"><summary>Payload</summary>\n\nbody\n\n</details>');
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).toBe("Payload");
  });

  test("a closer pressed against the last word does not swallow what follows", () => {
    // Only a `</details>` alone on its line used to close the fold, so this one
    // never matched: the depth never came back to zero and every paragraph after
    // the fold was dragged inside it.
    const blocks = parseBody("<details>\n<summary>Payload</summary>\nfolded</details>\n\nafter the fold");
    expect(blocks).toHaveLength(2);
    const d = blocks[0]!;
    if (d.kind !== "details") throw new Error("not details");
    expect(allText(d.blocks)).toContain("folded");
    expect(allText(d.blocks)).not.toContain("after the fold");
    expect(blocks[1]!.kind).toBe("para");
  });

  test("a whole fold on one line, and two of them on the same line", () => {
    const blocks = parseBody("<details><summary>one</summary>first</details><details><summary>two</summary>second</details>");
    expect(blocks.filter((b) => b.kind === "details")).toHaveLength(2);
    const [a, b] = blocks.filter((x) => x.kind === "details");
    if (a?.kind !== "details" || b?.kind !== "details") throw new Error("not details");
    expect(a.summary).toBe("one");
    expect(allText(a.blocks)).toContain("first");
    expect(b.summary).toBe("two");
    expect(allText(b.blocks)).toContain("second");
    // and neither fold took the other's contents
    expect(allText(a.blocks)).not.toContain("second");
  });

  test("a summary broken over several lines still names the fold", () => {
    // Line-at-a-time, this matched nothing: the fold came out called "Details"
    // and its title leaked into the body as a stray paragraph.
    const blocks = parseBody("<details>\n<summary>\n  Coverage report\n</summary>\n\nbody\n</details>");
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).toBe("Coverage report");
    expect(allText(d.blocks)).not.toContain("Coverage report");
    expect(allText(d.blocks)).toContain("body");
  });

  test("an untitled fold does not borrow the name of the one nested inside it", () => {
    const blocks = parseBody("<details>\n\n<details><summary>inner</summary>deep</details>\n\n</details>");
    const d = blocks[0]!;
    expect(d.kind).toBe("details");
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).toBe("Details");
    const kid = d.blocks.find((b) => b.kind === "details");
    expect(kid?.kind === "details" ? kid.summary : null).toBe("inner");
  });

  test("a fold that is never closed keeps the rest, the way a browser would", () => {
    const blocks = parseBody("<details><summary>Payload</summary>\n\nfolded\n\nstill folded");
    expect(blocks).toHaveLength(1);
    const d = blocks[0]!;
    if (d.kind !== "details") throw new Error("not details");
    expect(allText(d.blocks)).toContain("still folded");
  });
});

describe("alerts", () => {
  test("> [!WARNING] becomes an alert, not a quote", () => {
    const blocks = parseBody("> [!WARNING]\n> This drops the table.");
    const a = blocks[0]!;
    expect(a.kind).toBe("alert");
    if (a.kind !== "alert") throw new Error("not alert");
    expect(a.level).toBe("warning");
    expect(a.html).toContain("drops the table");
  });

  test("every level GitHub defines is recognised, case-insensitively", () => {
    for (const [raw, want] of [["NOTE", "note"], ["TIP", "tip"], ["IMPORTANT", "important"], ["WARNING", "warning"], ["CAUTION", "caution"], ["note", "note"]] as const) {
      const b = parseBody(`> [!${raw}]\n> body`)[0]!;
      expect(b.kind).toBe("alert");
      if (b.kind !== "alert") throw new Error("not alert");
      expect(b.level).toBe(want);
    }
  });

  test("an ordinary quote is still a quote", () => {
    expect(parseBody("> just quoting you")[0]!.kind).toBe("quote");
  });
});

describe("inline", () => {
  test("emoji shortcodes render, unknown ones are left alone", () => {
    expect(renderInline("ship it :rocket:")).toContain("🚀");
    expect(renderInline(":not_a_real_emoji:")).toContain(":not_a_real_emoji:");
  });

  test("#123 links to the repo it belongs to, and only when we know it", () => {
    expect(renderInline("fixes #123", "acme/orbit")).toContain('href="https://github.com/acme/orbit/issues/123"');
    // No repo in hand: leave it as text rather than link somewhere invented.
    expect(renderInline("fixes #123")).not.toContain("<a");
  });

  test("owner/repo#123 keeps its own repo", () => {
    const html = renderInline("see other/thing#7", "acme/orbit");
    expect(html).toContain("https://github.com/other/thing/issues/7");
  });

  test("a bare sha links to the commit and is shown short", () => {
    const html = renderInline("broke in 4a459f5c9b1", "acme/orbit");
    expect(html).toContain("/commit/4a459f5c9b1");
    expect(html).toContain("<code>4a459f5</code>");
  });

  test("still escapes, and still refuses to make a javascript: link clickable", () => {
    expect(renderInline("<script>alert(1)</script>")).not.toContain("<script>");
    // The text survives (escaped) — what must not happen is it becoming an
    // anchor. Only http(s) is ever linked.
    const html = renderInline("[x](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).not.toContain('href="javascript:');
  });

  test("code spans are left verbatim — no emoji or autolink inside them", () => {
    const html = renderInline("`:rocket:` and `#123`", "acme/orbit");
    expect(html).toContain("<code>:rocket:</code>");
    expect(html).not.toContain("🚀");
  });
});

describe("suggested changes", () => {
  test("a ```suggestion fence is its own kind, not an ordinary code block", () => {
    const blocks = parseBody("Try this:\n\n```suggestion\nconst x = 2;\n```");
    const sug = blocks.find((b) => b.kind === "suggestion");
    expect(sug).toBeTruthy();
    if (!sug || sug.kind !== "suggestion") throw new Error("no suggestion");
    expect(sug.text).toBe("const x = 2;");
    // and a normal fence is still a normal fence
    expect(parseBody("```ts\nconst y = 1;\n```")[0]!.kind).toBe("code");
  });

  test("the language match is case-insensitive and survives a longer fence", () => {
    expect(parseBody("````SUGGESTION\nz\n````")[0]!.kind).toBe("suggestion");
  });
});

describe("summary sanitisation", () => {
  // The old strip was a single `replace(/<[^>]+>/g, "")`, which is what CodeQL
  // called incomplete multi-character sanitization. Verified against it: each
  // of these came out with `<script` still in the string.
  test("an unclosed tag does not survive — the one-pass strip left it whole", () => {
    for (const evil of ["report <script", "a <script src=x", "<b>ok</b> <script"]) {
      expect(stripTags(evil)).not.toContain("<script");
      expect(stripTags(evil)).not.toContain("<");
    }
  });

  test("nested tags cannot reassemble into one", () => {
    expect(stripTags("<scr<b>ipt>alert(1)</scr</b>ipt>")).not.toContain("<script");
    expect(stripTags("<scr<b>ipt>")).not.toContain("<");
  });

  test("a <details> summary comes through as plain text, whatever was in it", () => {
    const blocks = parseBody("<details>\n<summary>report <script</summary>\nbody\n</details>");
    const d = blocks[0]!;
    if (d.kind !== "details") throw new Error("not details");
    expect(d.summary).not.toContain("<");
    expect(d.summary).not.toContain(">");
  });

  test("ordinary markup inside a summary is simply removed", () => {
    expect(stripTags("<b>Coverage</b> report")).toBe("Coverage report");
  });
});

describe("which viewer a changed file needs", () => {
  test("a binary image is an image, even though the parser gave it an entry", () => {
    // The bug this pins: `gh pr diff` emits a header for a binary file with no
    // hunks under it, so the parser yields an entry. Deciding on "is there a
    // parsed file" sent every PNG down the text path and drew an empty pane.
    expect(diffKind(".github/assets/pr.png", 0)).toBe("image");
    expect(diffKind("landing/hero.gif", 0)).toBe("image");
    expect(diffKind("web/public/favicon.svg", 0)).toBe("image");
  });

  test("a file with hunks is text, whatever it is called", () => {
    // An SVG that came through as a real textual diff should be read, not
    // rendered — the diff is the answer there.
    expect(diffKind("web/public/favicon.svg", 3)).toBe("text");
    expect(diffKind("server/src/prs.ts", 1)).toBe("text");
  });

  test("a binary that is not an image has nothing to show", () => {
    expect(diffKind("bun.lock", 0)).toBe("none");
    expect(diffKind("assets/font.woff2", 0)).toBe("none");
  });

  test("the extension test is case-insensitive and anchored to the end", () => {
    expect(diffKind("A/B/Shot.PNG", 0)).toBe("image");
    // `.png` in the middle of a name is not an image.
    expect(diffKind("src/png-encoder.ts", 0)).toBe("none");
  });
});
