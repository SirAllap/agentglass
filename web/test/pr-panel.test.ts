// The two pure functions behind the pull-request panel's readability.
//
// Both exist because of a specific complaint after using it for real: the whole
// pull request's diff was being dumped under the file list with no way to reach
// one file, and a body's tables rendered as raw pipes when a table is exactly
// how a before/after comparison gets written.
import { describe, expect, test } from "bun:test";
import { splitDiff, parseBody } from "../src/lib/prBody.ts";

describe("splitDiff", () => {
  const DIFF = [
    "diff --git a/src/app/views.py b/src/app/views.py",
    "index f10c7ce..f9d6c1e 100644",
    "--- a/src/app/views.py",
    "+++ b/src/app/views.py",
    "@@ -1,3 +1,4 @@",
    " context",
    "-gone",
    "+added",
    "diff --git a/src/app/utils.py b/src/app/utils.py",
    "index aaa..bbb 100644",
    "--- a/src/app/utils.py",
    "+++ b/src/app/utils.py",
    "@@ -10,2 +10,2 @@",
    "-old",
    "+new",
  ].join("\n");

  test("cuts one blob into per-file pieces", () => {
    const m = splitDiff(DIFF);
    expect([...m.keys()]).toEqual(["src/app/views.py", "src/app/utils.py"]);
    expect(m.get("src/app/utils.py")).toContain("+new");
    // Each piece keeps its own header, so it renders as a complete diff.
    expect(m.get("src/app/utils.py")!.startsWith("diff --git")).toBe(true);
  });

  test("a file's piece does not leak into the next", () => {
    const m = splitDiff(DIFF);
    expect(m.get("src/app/views.py")).not.toContain("+new");
    expect(m.get("src/app/utils.py")).not.toContain("+added");
  });

  /** The panel keys files by the b-side path, which is where a rename lands. */
  test("a rename is keyed by its destination", () => {
    const m = splitDiff("diff --git a/old/name.py b/new/name.py\n--- a/old/name.py\n+++ b/new/name.py\n");
    expect([...m.keys()]).toEqual(["new/name.py"]);
  });

  test("empty and header-less input yield nothing rather than throwing", () => {
    expect(splitDiff("").size).toBe(0);
    expect(splitDiff("just some text\nwith no header").size).toBe(0);
  });

  test("CRLF diffs split the same as LF ones", () => {
    expect([...splitDiff(DIFF.replace(/\n/g, "\r\n")).keys()]).toEqual([...splitDiff(DIFF).keys()]);
  });
});

describe("parseBody", () => {
  const kinds = (b: string) => parseBody(b).map((x) => x.kind);

  test("a markdown table becomes a table, not a wall of pipes", () => {
    const body = [
      "Proof of life",
      "",
      "| | RED (master) | GREEN (this PR) |",
      "|---|---|---|",
      "| Rows written | 1 | 2 |",
      "| Drift | 150 s | 0 s |",
      "",
      "after",
    ].join("\n");
    const blocks = parseBody(body);
    const table = blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    if (table?.kind !== "table") throw new Error("not a table");
    expect(table.head).toEqual(["", "RED (master)", "GREEN (this PR)"]);
    expect(table.rows).toHaveLength(2);
    expect(table.rows[1]).toEqual(["Drift", "150 s", "0 s"]);
  });

  /** A lone pipe in prose is not a table, and treating it as one ate the line. */
  test("a pipe without a divider row stays prose", () => {
    expect(kinds("a | b is not a table\nand nor is this")).toEqual(["text"]);
  });

  test("blockquotes are quoted rather than printed with their >", () => {
    const blocks = parseBody("> **Note:** if you modify critical files\n> the CI will post a checklist\n\nnormal");
    expect(blocks[0]!.kind).toBe("quote");
    if (blocks[0]!.kind !== "quote") throw new Error("not a quote");
    expect(blocks[0]!.html).not.toContain("&gt;");
    expect(blocks[0]!.html).toContain("Note:");
  });

  test("fenced code is kept verbatim, pipes and all", () => {
    const blocks = parseBody("text\n```\n| not | a | table |\n```\nmore");
    const code = blocks.find((b) => b.kind === "code");
    expect(code).toBeDefined();
    if (code?.kind !== "code") throw new Error("not code");
    expect(code.text).toBe("| not | a | table |");
  });

  test("images are lifted out so they can go through the proxy", () => {
    const blocks = parseBody('![RED before](https://user-images.githubusercontent.com/1/a.png)\ntext\n<img alt="GREEN" src="https://github.com/user-attachments/assets/x">');
    const imgs = blocks.filter((b) => b.kind === "image");
    expect(imgs).toHaveLength(2);
    if (imgs[0]!.kind !== "image" || imgs[1]!.kind !== "image") throw new Error("not images");
    expect(imgs[0]!.alt).toBe("RED before");
    expect(imgs[1]!.src).toContain("user-attachments");
  });

  /** Bodies arrive CRLF from GitHub; every rule here is line-anchored. */
  test("CRLF bodies parse identically to LF ones", () => {
    const body = "## Head\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n> quoted\n";
    expect(kinds(body.replace(/\n/g, "\r\n"))).toEqual(kinds(body));
  });
});
