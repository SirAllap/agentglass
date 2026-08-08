/*
 * A ClickUp comment's formatting, kept.
 *
 * The blocks below are not invented: they are the shapes a real triage comment
 * on a real card is made of, dumped from the API and pasted here. That matters
 * because Quill's own documentation describes a format, while ClickUp emits a
 * dialect of it — `list` is `{list:{list:"bullet"}}` rather than
 * `{list:"bullet"}`, `code-block` carries its language nested under its own
 * name, and a divider is `type`d instead of attributed. Every one of those is a
 * thing this converter got wrong when written against the documentation.
 *
 * What is asserted is the thing the reader lost: the comment came through as
 * one grey paragraph — no heading, no bullet, no fence, no inline code — and
 * the block of test output it was written to carry was indistinguishable from
 * the sentence above it.
 */
import { describe, expect, test } from "bun:test";
import { commentMarkdown } from "../src/clickup.ts";

/** `attributes` on the piece whose text is the newline; that piece's
 *  attributes describe the LINE it ends. This is the part that is easy to get
 *  backwards, so the fixtures spell it out. */
const nl = (attributes?: Record<string, unknown>) => ({ text: "\n", attributes: attributes ?? {} });

describe("what a comment keeps", () => {
  test("a heading is a heading", () => {
    expect(commentMarkdown([{ text: "Bug Triage - First Pass" }, nl({ header: 2 })]))
      .toBe("## Bug Triage - First Pass");
    expect(commentMarkdown([{ text: "Summary" }, nl({ header: 3 })]))
      .toBe("### Summary");
  });

  test("bullets and numbers, in ClickUp's own spelling of them", () => {
    // `{list: {list: "bullet"}}`, not `{list: "bullet"}`. Measured.
    const md = commentMarkdown([
      { text: "Who is affected:", attributes: { bold: true } },
      { text: " Shops configuring per-currency price lists." },
      nl({ list: { list: "bullet" } }),
      { text: "Then this one." },
      nl({ list: { list: "ordered" } }),
    ]);
    expect(md).toBe("- **Who is affected:** Shops configuring per-currency price lists.\n1. Then this one.");
  });

  test("a fenced block, gathered rather than one fence per line", () => {
    const md = commentMarkdown([
      { text: "test_checkout_rejects_a_zero_quantity_line  ... ok" },
      nl({ "code-block": { "code-block": "css" } }),
      { text: "Ran 4 tests in 0.052s" },
      nl({ "code-block": { "code-block": "css" } }),
      { text: "after" },
      nl(),
    ]);
    expect(md).toBe(
      "```css\ntest_checkout_rejects_a_zero_quantity_line  ... ok\nRan 4 tests in 0.052s\n```\nafter",
    );
  });

  test("inline code, and bold that wraps it", () => {
    // ClickUp splits a bold sentence at every code span inside it, so the naive
    // per-run wrapping produced `**leave ****`required`**** out**` — four
    // asterisks in a row, which no reader parses. One pair per run of runs.
    const md = commentMarkdown([
      { text: "Scope recommendation — leave ", attributes: { bold: true } },
      { text: "required", attributes: { bold: true, code: true } },
      { text: " out.", attributes: { bold: true } },
      nl(),
    ]);
    expect(md).toBe("**Scope recommendation — leave `required` out.**");
    expect(md).not.toContain("****");
  });

  test("a divider is its own line", () => {
    // It arrives with its text already `---` and NO newline of its own, so
    // without handling it welds onto the sign-off written under the rule.
    const md = commentMarkdown([
      { text: "last line" }, nl(),
      { text: "---", type: "divider" },
      { text: "Automated triage", attributes: { italic: true } }, nl(),
    ]);
    expect(md).toBe("last line\n\n---\n\n*Automated triage*");
  });

  test("a link keeps its address", () => {
    expect(commentMarkdown([{ text: "the PR", attributes: { link: "https://example.com/p/1" } }, nl()]))
      .toBe("[the PR](https://example.com/p/1)");
  });
});

describe("text that must not be read as formatting", () => {
  test("escapes the characters the renderer acts on", () => {
    // A glob in a sentence. Unescaped, `**` opens an emphasis run that eats the
    // rest of the line.
    const md = commentMarkdown([{ text: "look under src/**/*.py for it" }, nl()]);
    expect(md).toBe("look under src/\\*\\*/\\*.py for it");
  });

  test("leaves underscores alone", () => {
    /*
     * The mirror-image mistake, and the more likely one here: these comments
     * are about code, so `snake_case` is on every other line. This renderer
     * gives `_` no meaning, so escaping it would put a visible backslash
     * through every identifier in the comment to prevent nothing.
     */
    const md = commentMarkdown([{ text: "_validate_final_total and all_line_types" }, nl()]);
    expect(md).toBe("_validate_final_total and all_line_types");
  });

  test("does not escape inside a fence, where text is verbatim", () => {
    const md = commentMarkdown([
      { text: "grep -r '*.py' ." },
      nl({ "code-block": { "code-block": "" } }),
    ]);
    expect(md).toBe("```\ngrep -r '*.py' .\n```");
  });

  test("leaves the start of a line alone", () => {
    // Somebody who typed "1. " into a paragraph ClickUp did not mark as a list
    // still meant a numbered line, and that is what they were looking at.
    expect(commentMarkdown([{ text: "1. first thing" }, nl()])).toBe("1. first thing");
  });
});

describe("the whole comment", () => {
  test("collapses an editor's empty paragraphs to one blank line", () => {
    const md = commentMarkdown([
      { text: "one" }, nl(), nl(), nl(), nl(),
      { text: "two" }, nl(),
    ]);
    expect(md).toBe("one\n\ntwo");
  });

  test("is empty for a comment with nothing in it, so the caller can fall back", () => {
    expect(commentMarkdown([])).toBe("");
    expect(commentMarkdown([nl(), nl()])).toBe("");
  });
});
