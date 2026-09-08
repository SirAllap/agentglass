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

/*
 * A table's cells, and the one character that can end the row it is in.
 *
 * `|` is the column separator, so a cell that contains one has to escape it —
 * and escaping is where this went wrong. Only the pipe was escaped, which is
 * fine until the cell also has a backslash in front of it: markdown reads `\\`
 * as one literal backslash and then meets a BARE pipe, and the row gains a
 * column that nobody wrote. A Windows path or a regex in a cell is enough.
 *
 * Every cell below carries the count it should draw, because the failure is
 * silent — the table still renders, just with the columns shifted one to the
 * left from the broken cell onwards.
 */
describe("a table's cells", () => {
  const table = (cells: string[][]) => commentMarkdown([{
    "table-embed": {
      rows: cells.map(() => ({})),
      columns: cells[0].map(() => ({})),
      cells: Object.fromEntries(cells.flatMap((row, r) =>
        row.map((text, c) => [`${r + 1}:${c + 1}`, { content: [{ insert: text }] }]))),
    },
  }]);
  /** Columns as a READER counts them: the separators markdown still acts on. */
  const columnsOn = (line: string) => line.replace(/\\[\s\S]/g, "").split("|").length - 1;

  test("draws a header, a rule and the rest", () => {
    expect(table([["Field", "Value"], ["retries", "3"]]))
      .toBe("| Field | Value |\n| --- | --- |\n| retries | 3 |");
  });

  test("a pipe in a cell stays inside its cell", () => {
    const md = table([["what", "pattern"], ["either", "a|b"]]);
    expect(md).toContain("| either | a\\|b |");
    expect(columnsOn(md.split("\n")[2])).toBe(3);
  });

  test("a backslash before a pipe does not open a column", () => {
    /*
     * The regression. `C:\|next` was escaped to `C:\\|next` — a literal
     * backslash followed by a live separator — so this row drew FOUR columns
     * where the header drew three. The escape now goes on the backslash first
     * and the pipe second; the other order would re-escape the backslashes the
     * pipe pass had just written and print them.
     */
    const md = table([["where", "cell"], ["drive", "C:\\|next"]]);
    const [header, , row] = md.split("\n");
    expect(row).toBe("| drive | C:\\\\\\|next |");
    expect(columnsOn(row)).toBe(columnsOn(header));
  });

  test("a lone backslash is drawn, not eaten", () => {
    // `\` before an ordinary character escapes it away in markdown, so an
    // unescaped trailing backslash swallows the space and the separator after
    // it — the same broken row by a different route.
    const md = table([["path"], ["share\\"]]);
    expect(md.split("\n")[2]).toBe("| share\\\\ |");
  });
});

/*
 * A PICTURE IN A COMMENT.
 *
 * The blocks are the two shapes a real card carried, with the names changed: a
 * file dropped on a comment arrives as `type: "attachment"`, a screenshot
 * pasted into the editor as `type: "image"`, and their `text` is the file name
 * in both. Handling neither is how a comment that was half evidence rendered as
 * the word `image.png` on a line of its own.
 */
describe("a picture in a comment", () => {
  const attachment = (over?: Record<string, unknown>) => ({
    type: "attachment",
    text: "orbit-01-red-dashboard.png",
    attachment: {
      id: "0a251062.png",
      title: "orbit-01-red-dashboard.png",
      mimetype: "image/png",
      url: "https://t9900001.p.clickup-attachments.com/t9900001/0a251062/orbit-01-red-dashboard.png",
      url_w_host: "https://t9900001.p.clickup-attachments.com/t9900001/0a251062/orbit-01-red-dashboard.png",
      ...over,
    },
  });

  const pasted = {
    type: "image",
    text: "image.png",
    attributes: { width: "300", "data-id": "00f68b40.png" },
    image: {
      id: "00f68b40.png",
      name: "image.png",
      url: "https://t9900001.p.clickup-attachments.com/t9900001/00f68b40/image.png",
      thumbnail_large: "https://t9900001.p.clickup-attachments.com/t9900001/00f68b40/image.png",
    },
  };

  test("an attached image is an image, not its file name", () => {
    expect(commentMarkdown([attachment(), nl()]))
      .toBe("![orbit-01-red-dashboard.png](https://t9900001.p.clickup-attachments.com/t9900001/0a251062/orbit-01-red-dashboard.png)");
  });

  test("a pasted screenshot is an image too", () => {
    // The second shape, and the one the reader actually meets most: `image`
    // rather than `attachment`, and no mimetype anywhere on the block.
    expect(commentMarkdown([pasted, nl()]))
      .toBe("![image.png](https://t9900001.p.clickup-attachments.com/t9900001/00f68b40/image.png)");
  });

  test("a file that is not a picture is a link, not a broken image", () => {
    // `![]()` on a PDF draws the broken-image icon where a readable name used
    // to be, which is a worse answer than the bug being fixed.
    const pdf = attachment({ title: "orbit-audit.pdf", mimetype: "application/pdf" });
    expect(commentMarkdown([{ ...pdf, text: "orbit-audit.pdf" }, nl()]))
      .toBe("[orbit-audit.pdf](https://t9900001.p.clickup-attachments.com/t9900001/0a251062/orbit-01-red-dashboard.png)");
  });

  test("the sentence around a screenshot survives it", () => {
    // Measured on a real thread: the picture sits between two runs of prose on
    // ONE line. Ending the line at the image would cut the sentence in half.
    expect(commentMarkdown([{ text: "before " }, pasted, { text: " after" }, nl()]))
      .toBe("before ![image.png](https://t9900001.p.clickup-attachments.com/t9900001/00f68b40/image.png) after");
  });

  test("a name with a bracket cannot break out of its own alt text", () => {
    const odd = attachment({ title: "orbit [draft].png" });
    expect(commentMarkdown([{ ...odd, text: "orbit [draft].png" }, nl()]))
      .toBe("![orbit  draft .png](https://t9900001.p.clickup-attachments.com/t9900001/0a251062/orbit-01-red-dashboard.png)");
  });

  test("a space in the URL is encoded, because the reader's pattern stops at one", () => {
    const spaced = attachment({ url_w_host: "https://t9900001.p.clickup-attachments.com/t9900001/0a251062/two words.png" });
    expect(commentMarkdown([{ ...spaced, text: "two words.png" }, nl()]))
      .toBe("![two words.png](https://t9900001.p.clickup-attachments.com/t9900001/0a251062/two%20words.png)");
  });

  test("a block with no URL is left alone rather than drawn as an empty image", () => {
    const naked = { type: "attachment", text: "gone.png", attachment: { title: "gone.png", mimetype: "image/png" } };
    expect(commentMarkdown([naked, nl()])).toBe("gone.png");
  });
});
