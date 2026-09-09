/*
 * The markdown parser, tested on the bodies this app actually shows.
 *
 * Every fixture below is the shape of something real: this project's own pull
 * request template, a review bot's finding with a table, a description with a
 * screenshot in it. A parser tested on invented markdown passes and then meets
 * a checklist it renders as a wall of `- [x]`.
 */
import { describe, expect, test } from "bun:test";
import { inlineText, parseInline, parseMarkdown, type Block } from "../src/md/parse.ts";

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
    "- [ ] If there are changes in prompts, I have added the `Evals` label so CI runs the eval suite.",
    "",
    "## CU reference",
    "",
    "https://app.clickup.com/t/14295188/PROJ-18040",
  );

  const blocks = parseMarkdown(body);

  test("the boxes are state, not text", () => {
    const [list] = only(blocks, "list");
    expect(list!.items.map((i) => i.checked)).toEqual([true, true, false, false]);
  });

  test("an item keeps its link and its code span", () => {
    const [list] = only(blocks, "list");
    expect(list!.items[0]!.kids.some((k) => k.t === "link")).toBe(true);
    expect(inlineText(list!.items[3]!.kids)).toContain("Evals");
    expect(list!.items[3]!.kids.some((k) => k.t === "code" && k.text === "Evals")).toBe(true);
  });

  test("both headings survive, at their own level", () => {
    expect(only(blocks, "h").map((h) => [h.level, inlineText(h.kids)]))
      .toEqual([[2, "Checklist"], [2, "CU reference"]]);
  });

  test("the bare CU address is a link — it is written without brackets", () => {
    const last = blocks[blocks.length - 1]!;
    expect(last.t).toBe("p");
    expect(last.t === "p" && last.kids[0]!.t === "link").toBe(true);
    expect(last.t === "p" && last.kids[0]!.t === "link" && last.kids[0]!.href)
      .toBe("https://app.clickup.com/t/14295188/PROJ-18040");
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
