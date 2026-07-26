// The markdown a pull request is actually written in.
//
// Each case here is something that turned up in a real body or bot comment and
// rendered wrong: a folded <details> that came through as escaped tags, a
// GitHub callout that read as a quote, `#123` that stayed plain text, `:tada:`
// as punctuation. The escaping tests are the ones with teeth — a body is a
// string a stranger wrote.
import { describe, expect, test } from "bun:test";
import { parseBody, renderInline } from "../src/lib/prBody.ts";

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
