/*
 * The markdown parser, tested on the bodies this app actually shows.
 *
 * Every fixture below is the shape of something real: this project's own pull
 * request template, a review bot's finding with a table, a description with a
 * screenshot in it. A parser tested on invented markdown passes and then meets
 * a checklist it renders as a wall of `- [x]`.
 */
import { describe, expect, test } from "bun:test";
import { foldAt, inlineText, parseInline, parseMarkdown, plainInline, type Block } from "../src/md/parse.ts";

const md = (...lines: string[]): string => lines.join("\n");

const only = <T extends Block["t"]>(blocks: Block[], t: T): Extract<Block, { t: T }>[] =>
  blocks.filter((b): b is Extract<Block, { t: T }> => b.t === t);

describe("the checklist every pull request here opens with", () => {
  const body = md(
    "## Checklist",
    "Please check the following items before submitting your PR:",
    "",
    "- [x] I have followed the [Checks before submitting a Pull Request](https://github.com/x/y/blob/master/docs/submit.md) document.",
    "- [x] I have added the necessary tests for this feature, if needed.",
    "- [ ] I have updated the documentation accordingly, if needed.",
    "- [ ] If this changes the public API, I have added the `api` label so CI runs the contract suite.",
    "",
    "## Task reference",
    "",
    "https://app.clickup.com/t/9000001/ORBIT-1042",
  );

  const blocks = parseMarkdown(body);

  test("the boxes are state, not text", () => {
    const [list] = only(blocks, "list");
    expect(list!.items.map((i) => i.checked)).toEqual([true, true, false, false]);
  });

  test("an item keeps its link and its code span", () => {
    const [list] = only(blocks, "list");
    expect(list!.items[0]!.kids.some((k) => k.t === "link")).toBe(true);
    expect(inlineText(list!.items[3]!.kids)).toContain("api");
    expect(list!.items[3]!.kids.some((k) => k.t === "code" && k.text === "api")).toBe(true);
  });

  test("both headings survive, at their own level", () => {
    expect(only(blocks, "h").map((h) => [h.level, inlineText(h.kids)]))
      .toEqual([[2, "Checklist"], [2, "Task reference"]]);
  });

  test("the bare CU address is a link — it is written without brackets", () => {
    const last = blocks[blocks.length - 1]!;
    expect(last.t).toBe("p");
    expect(last.t === "p" && last.kids[0]!.t === "link").toBe(true);
    expect(last.t === "p" && last.kids[0]!.t === "link" && last.kids[0]!.href)
      .toBe("https://app.clickup.com/t/9000001/ORBIT-1042");
  });

  test("a sentence directly above a list stays a sentence", () => {
    const [para] = only(blocks, "p");
    expect(inlineText(para!.kids)).toBe("Please check the following items before submitting your PR:");
  });
});

describe("what a review bot writes", () => {
  const body = md(
    "<!-- pr-template-nudge -->",
    "**[High]** `tasks.py` — a second join can be scheduled alongside the first.",
    "",
    "| Alert | Package | Patched |",
    "| --- | --- | --- |",
    "| #2 | `image-size` | none exists |",
    "| #5 | `query-string` | 0.5.0 |",
    "",
    "```python",
    "# not a heading, and not a list",
    "- cache.set(key, True, timeout=300)",
    "```",
  );

  const blocks = parseMarkdown(body);

  test("the machine-addressed comment is dropped, not printed", () => {
    expect(JSON.stringify(blocks)).not.toContain("pr-template-nudge");
  });

  test("the table keeps its header and every row", () => {
    const [table] = only(blocks, "table");
    expect(table!.head.map(inlineText)).toEqual(["Alert", "Package", "Patched"]);
    expect(table!.rows).toHaveLength(2);
    expect(table!.rows[0]!.map(inlineText)).toEqual(["#2", "image-size", "none exists"]);
  });

  test("a fence is text, whatever it looks like inside", () => {
    const [code] = only(blocks, "code");
    expect(code!.lang).toBe("python");
    expect(code!.text).toContain("- cache.set(key, True, timeout=300)");
    expect(only(blocks, "list")).toHaveLength(0);
  });

  test("severity stays bold and the file stays code", () => {
    const [para] = only(blocks, "p");
    expect(para!.kids[0]!.t).toBe("strong");
    expect(para!.kids.some((k) => k.t === "code" && k.text === "tasks.py")).toBe(true);
  });
});

describe("an HTML comment is hidden the way a browser hides it", () => {
  const gone = (body: string, marker = "secret"): void => {
    expect(JSON.stringify(parseMarkdown(body))).not.toContain(marker);
  };

  test("the ordinary one, on its own line and inline", () => {
    gone("<!-- secret -->");
    gone("before <!-- secret --> after");
    expect(inlineText(only(parseMarkdown("before <!-- secret --> after"), "p")[0]!.kids))
      .toBe("before  after");
  });

  test("the short forms a browser closes early", () => {
    // `<!-->` and `<!--->` are whole comments; what follows them is text.
    expect(inlineText(only(parseMarkdown("<!-->secret is text"), "p")[0]!.kids)).toBe("secret is text");
    expect(inlineText(only(parseMarkdown("<!--->secret is text"), "p")[0]!.kids)).toBe("secret is text");
  });

  test("`--!>` closes one too, so what follows is not left hidden", () => {
    expect(inlineText(only(parseMarkdown("<!-- x --!>shown"), "p")[0]!.kids)).toBe("shown");
  });

  test("dashes inside a comment do not close it", () => {
    gone("<!-- secret --- still secret -->");
    expect(parseMarkdown("<!-- a --- b -->post")[0]).toEqual({ t: "p", kids: [{ t: "text", text: "post" }] });
  });

  test("an unterminated comment takes the rest, rather than printing it", () => {
    gone(md("intro", "<!-- secret", "secret too"));
    expect(inlineText(only(parseMarkdown(md("intro", "<!-- secret")), "p")[0]!.kids)).toBe("intro");
  });

  test("a lone `<!--` in a code span is still hidden — and nothing throws", () => {
    expect(() => parseMarkdown("`<!--` and `-->`")).not.toThrow();
  });
});

describe("nesting, quotes and images", () => {
  test("a sub-list belongs to the item above it, not to the list", () => {
    const [list] = only(parseMarkdown(md(
      "- Reproduced on three calls",
      "  - all Spanish",
      "  - all redacted",
      "- The pro's inbox shows no attachment",
    )), "list");
    expect(list!.items).toHaveLength(2);
    const [nested] = only(list!.items[0]!.children, "list");
    expect(nested!.items.map((i) => inlineText(i.kids))).toEqual(["all Spanish", "all redacted"]);
  });

  test("a numbered list keeps the number it started at", () => {
    const [list] = only(parseMarkdown(md("3. third", "4. fourth")), "list");
    expect(list!.ordered).toBe(true);
    expect(list!.start).toBe(3);
  });

  test("a quote is its own blocks, and a wrapped line stays in it", () => {
    const [quote] = only(parseMarkdown(md("> Measured rather than argued,", "and the answer is cost.")), "quote");
    expect(inlineText(only(quote!.blocks, "p")[0]!.kids)).toBe("Measured rather than argued, and the answer is cost.");
  });

  test("a screenshot on its own line is an image, with its source kept whole", () => {
    const [image] = only(parseMarkdown("![the pro's empty inbox](https://github.com/user-attachments/assets/9f2c.png)"), "image");
    expect(image!.alt).toBe("the pro's empty inbox");
    expect(image!.src).toBe("https://github.com/user-attachments/assets/9f2c.png");
  });

  test("a rule is a rule, and three dashes under text are not", () => {
    expect(only(parseMarkdown("---"), "hr")).toHaveLength(1);
    expect(only(parseMarkdown(md("Heading", "---")), "hr")).toHaveLength(1);
  });
});

describe("nothing is swallowed", () => {
  test("an unknown construct survives as the text somebody typed", () => {
    const [para] = only(parseMarkdown("A footnote[^1] and <kbd>Ctrl</kbd> stay readable."), "p");
    expect(inlineText(para!.kids)).toBe("A footnote[^1] and <kbd>Ctrl</kbd> stay readable.");
  });

  test("an unclosed fence takes the rest of the body rather than losing it", () => {
    const [code] = only(parseMarkdown(md("```", "still here")), "code");
    expect(code!.text).toBe("still here");
  });

  test("an escaped marker is a character, not emphasis", () => {
    expect(inlineText(parseInline("2 \\* 3 \\* 4"))).toBe("2 * 3 * 4");
  });

  test("a path inside code does not turn the sentence bold", () => {
    const kids = parseInline("`**/*.ts` and then plain text");
    expect(kids[0]!.t).toBe("code");
    expect(kids.some((k) => k.t === "strong")).toBe(false);
  });

  test("an empty body is no blocks rather than an empty paragraph", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n  \n")).toEqual([]);
  });
});

/*
 * A body is text a stranger wrote, so the parser's cost has to stay linear in
 * its length. Three of these lines used to be quadratic: a table's rule row and
 * a thematic break both repeated a group with an optional-space run inside it,
 * and a bare address ended in two overlapping character classes. CodeQL called
 * the first one on the way in.
 *
 * The bound is deliberately loose. It is not a benchmark — it is the difference
 * between milliseconds and a phone that stops answering, and a tight number
 * here would fail on a busy runner while proving nothing extra.
 */
describe("a hostile body cannot hang the screen", () => {
  const under = (name: string, body: string): void => {
    test(name, () => {
      const started = performance.now();
      parseMarkdown(body);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  };

  under("a rule row of four thousand dashes", `| ${"-".repeat(4000)}${" ".repeat(200)}${"|".repeat(200)}`);
  under("four thousand dashes and spaces", "- ".repeat(4000));
  under("an address with a tail of punctuation", `https://x.example/${"a".repeat(6000)}.....`);
  under("a run of backticks that closes nothing", `${"`".repeat(4000)}text`);
  under("emphasis that is never closed", `**${"a ".repeat(4000)}`);
  under("a thousand comment openings that never close", `${"<!--".repeat(1000)}text`);
  under("a comment full of dashes", `<!-- ${"-".repeat(8000)} -->tail`);
  under("four hundred lines of shifting indent", Array.from({ length: 400 }, (_, i) => `${" ".repeat(i % 20)}- item`).join("\n"));
});

/*
 * The Talk tab's collapsed bot row draws one line with no `Md` under it, so
 * a coverage bot's own emphasis and links used to show up literally:
 * "Coverage: **87.4%**" rather than "Coverage: 87.4%".
 */
describe("plainInline, for a preview with no renderer under it", () => {
  test("emphasis is taken off, the words kept", () => {
    expect(plainInline("Coverage: **87.4%**")).toBe("Coverage: 87.4%");
    expect(plainInline("_patch_ coverage")).toBe("patch coverage");
  });

  test("a code span keeps its text and drops the backticks", () => {
    expect(plainInline("run `make check` first")).toBe("run make check first");
  });

  test("a link keeps its label, drops the address", () => {
    expect(plainInline("see the [report](https://example.test/cov)")).toBe("see the report");
  });

  test("plain text with nothing to strip is unchanged", () => {
    expect(plainInline("3 files failed")).toBe("3 files failed");
  });
});

/* A pasted screenshot is `<img width="…" src="…">`, and a sentence can carry
 * `![…](…)`: both arrived as text and a blue word instead of the picture. */
describe("pictures that are not alone on a line", () => {
  const shot = "https://github.com/user-attachments/assets/4d1f";

  test("the tag GitHub writes for a pasted screenshot is an image", () => {
    const blocks = parseMarkdown(`<img width="640" alt="before the fix" src="${shot}" />`);
    expect(blocks).toEqual([{ t: "image", src: shot, alt: "before the fix" }]);
  });

  test("an image inside a sentence sits where the author put it", () => {
    const blocks = parseMarkdown(`Before: ![old](https://x.test/a.png) after: <img src='https://x.test/b.png'> done`);
    expect(blocks.map((b) => b.t)).toEqual(["p", "image", "p", "image", "p"]);
    expect((blocks[1] as unknown as { src: string }).src).toBe("https://x.test/a.png");
    expect((blocks[3] as unknown as { src: string }).src).toBe("https://x.test/b.png");
    expect(inlineText((blocks[4] as unknown as { kids: never[] }).kids)).toBe(" done");
  });

  test("a picture inside a link, the badge shape, is the picture", () => {
    expect(parseMarkdown("[![ci](https://x.test/ci.svg)](https://x.test/runs)"))
      .toEqual([{ t: "image", src: "https://x.test/ci.svg", alt: "ci" }]);
    expect(parseMarkdown(`<a href="https://x.test/big"><img src="https://x.test/small.png"></a>`))
      .toEqual([{ t: "image", src: "https://x.test/small.png", alt: "" }]);
  });

  test("an image in a list item goes under it, the text stays", () => {
    const [list] = parseMarkdown("- evidence ![s](https://x.test/s.png)");
    const item = (list as unknown as { items: { kids: never[]; children: Block[] }[] }).items[0]!;
    expect(inlineText(item.kids)).toBe("evidence ");
    expect(item.children).toEqual([{ t: "image", src: "https://x.test/s.png", alt: "s" }]);
  });

  test("a tag with nothing to fetch is dropped, not printed", () => {
    expect(parseMarkdown(`before <img alt="x"> after`).map((b) => b.t)).toEqual(["p"]);
    expect(inlineText((parseMarkdown(`before <img src="javascript:alert(1)"> after`)[0] as unknown as { kids: never[] }).kids))
      .toBe("before  after");
  });

  test("in a heading there is nowhere to put one: its alt text stands in", () => {
    const [h] = parseMarkdown("# Look ![logo](https://x.test/l.png)");
    expect(inlineText((h as unknown as { kids: never[] }).kids)).toBe("Look logo");
  });
});

/* What a bot's comment is made of: a fold, an HTML table on one line, a badge,
 * an issue number, a shortcode. Each arrived as its own source. */
describe("the rest of what a bot writes", () => {
  const flat = (blocks: Block[]): string => JSON.stringify(blocks);

  test("`<details>` is a fold with its summary, and its inside is a document", () => {
    const [d] = parseMarkdown(md("<details>", "<summary>Coverage report</summary>", "", "- one", "- two", "", "</details>"));
    expect(d).toMatchObject({ t: "details", summary: "Coverage report" });
    expect((d as unknown as { blocks: Block[] }).blocks.map((b) => b.t)).toEqual(["list"]);
  });

  test("the one-line shape every bot emits, and two folds on one line", () => {
    const blocks = parseMarkdown("<details><summary>A</summary>first</details><details><summary>B</summary>second</details>");
    expect(blocks.map((b) => (b as unknown as { summary?: string }).summary)).toEqual(["A", "B"]);
  });

  test("an unclosed fold owns the rest, and text after a closed one is kept", () => {
    expect(parseMarkdown("<details><summary>A</summary>inside").length).toBe(1);
    const blocks = parseMarkdown(md("<details><summary>A</summary>x</details>", "after"));
    expect(blocks.map((b) => b.t)).toEqual(["details", "p"]);
  });

  test("nested folds keep their own summaries", () => {
    const [outer] = parseMarkdown("<details><summary>Out</summary><details><summary>In</summary>x</details></details>");
    expect((outer as unknown as { summary: string }).summary).toBe("Out");
    expect((outer as unknown as { blocks: Block[] }).blocks[0]).toMatchObject({ t: "details", summary: "In" });
  });

  test("an HTML table on ONE line is a table, a header row promoted when there is no <th>", () => {
    const [t] = parseMarkdown("<table><tr><th>File</th><th>Cover</th></tr><tr><td><b>a.ts</b></td><td>91%</td></tr></table>");
    expect(t!.t).toBe("table");
    const table = t as Extract<Block, { t: "table" }>;
    expect(table.head.map(inlineText)).toEqual(["File", "Cover"]);
    expect(table.rows[0]!.map(inlineText)).toEqual(["a.ts", "91%"]);
    const [bare] = parseMarkdown("<table><tr><td>x</td><td>y</td></tr><tr><td>1</td><td>2</td></tr></table>");
    expect((bare as Extract<Block, { t: "table" }>).head.map(inlineText)).toEqual(["x", "y"]);
  });

  test("text before a table is kept, and text after `</table>` is read again", () => {
    const blocks = parseMarkdown("Report: <table><tr><td>a</td></tr></table> done");
    expect(blocks.map((b) => b.t)).toEqual(["p", "table", "p"]);
  });

  test("a shields.io badge is a badge, never a fetch", () => {
    const [p] = parseMarkdown("![cov](https://img.shields.io/badge/coverage-75%25-green) on main");
    const badge = (p as unknown as { kids: { t: string; label?: string; value?: string; color?: string }[] }).kids[0]!;
    expect(badge).toEqual({ t: "badge", label: "coverage", value: "75%", color: "green" });
    // alone on its line, too — that line would otherwise be an image block
    expect(parseMarkdown("![cov](https://img.shields.io/badge/coverage-75%25-green)")[0]!.t).toBe("p");
    expect(parseMarkdown("[![ci](https://img.shields.io/badge/build-passing-brightgreen)](https://x.test/runs)")[0]!.t).toBe("p");
  });

  test("#123 is a link to that issue in THIS repository, and only with one known", () => {
    const [p] = parseMarkdown("Fixes #123, not abc#4 or &#39;", { repo: "acme/orbit" });
    const links = (p as unknown as { kids: { t: string; href?: string }[] }).kids.filter((k) => k.t === "link") as unknown[];
    expect(links).toEqual([{ t: "link", href: "https://github.com/acme/orbit/issues/123", kids: [{ t: "text", text: "#123" }] }]);
    expect(flat(parseMarkdown("Fixes #123"))).not.toContain("issues/");
  });

  test("a known shortcode is its emoji, an unknown one stays as typed", () => {
    expect(inlineText((parseMarkdown("ship it :rocket: and :nosuchcode:")[0] as unknown as { kids: never[] }).kids))
      .toBe("ship it 🚀 and :nosuchcode:");
  });

  test("a code span keeps its shortcode and its issue number as text", () => {
    const [p] = parseMarkdown("`:rocket: #1`", { repo: "acme/orbit" });
    expect(inlineText((p as unknown as { kids: never[] }).kids)).toBe(":rocket: #1");
  });
});

describe("where the fold cuts", () => {
  test("it runs on to a picture just past it, and leaves a far one alone", () => {
    const near = Array.from({ length: 7 }, () => ({ t: "hr" }) as Block);
    near[6] = { t: "image", src: "https://x.test/a.png", alt: "" };
    expect(foldAt(near, 5)).toBe(7);
    const far = Array.from({ length: 30 }, () => ({ t: "hr" }) as Block);
    far[20] = { t: "image", src: "https://x.test/a.png", alt: "" };
    expect(foldAt(far, 5)).toBe(5);
    expect(foldAt([], 5)).toBe(5);
  });
});
