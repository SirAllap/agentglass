// The markdown a pull request is actually written in.
//
// Each case here is something that turned up in a real body or bot comment and
// rendered wrong: a folded <details> that came through as escaped tags, a
// GitHub callout that read as a quote, `#123` that stayed plain text, `:tada:`
// as punctuation. The escaping tests are the ones with teeth — a body is a
// string a stranger wrote.
import { describe, expect, test } from "bun:test";
import { parseBody, renderInline, stripTags, diffKind, toggleChecklistItem, type MdBlock } from "../src/lib/prBody.ts";

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

// A CI comment is the shape markdown rendering actually has to survive: the
// body is machine-written, the fold carries the only content anyone wants, and
// the markers the bot uses to find its own comment later are not for reading.
describe("a coverage bot's comment", () => {
  // What github-actions' pytest-coverage-comment really emits: a marker, then
  // badge and fold pressed onto one line.
  const BOT = [
    "<!-- Pytest Coverage Comment: vaptt-unit-tests | vaptt -->",
    '<a href="https://github.com/acme/orbit/blob/abc/README.md"><img alt="Coverage" src="https://img.shields.io/badge/Coverage-75%25-yellow.svg"></a><details><summary>Coverage (vaptt)</summary>',
    "",
    "| File | Stmts |",
    "| --- | --- |",
    "| models.py | 188 |",
    "",
    "</details>",
    "<!-- Sticky Pull Request Commentpatch-coverage-vaptt -->",
  ].join("\n");

  test("the machine markers do not reach the screen", () => {
    const html = JSON.stringify(parseBody(BOT));
    expect(html).not.toContain("Pytest Coverage Comment");
    expect(html).not.toContain("Sticky Pull Request");
  });

  test("a fold pressed onto the end of another line is still a fold", () => {
    const blocks = parseBody(BOT);
    const det = blocks.find((b) => b.kind === "details");
    expect(det).toBeDefined();
    expect((det as Extract<MdBlock, { kind: "details" }>).summary).toBe("Coverage (vaptt)");
  });

  test("the badge on that same line survives it", () => {
    const img = parseBody(BOT).find((b) => b.kind === "image");
    expect(img).toBeDefined();
    expect((img as Extract<MdBlock, { kind: "image" }>).src).toContain("img.shields.io");
  });

  test("the table inside the fold is a table, not a row of pipes", () => {
    const det = parseBody(BOT).find((b) => b.kind === "details") as Extract<MdBlock, { kind: "details" }>;
    const table = det.blocks.find((b) => b.kind === "table");
    expect(table).toBeDefined();
    expect((table as Extract<MdBlock, { kind: "table" }>).head).toEqual(["File", "Stmts"]);
  });

  test("a comment that is part of a sentence is left alone", () => {
    // Only whole-line comments are noise; this one is someone showing syntax.
    const blocks = parseBody("Write <!-- like this --> to hide a note");
    expect(JSON.stringify(blocks)).toContain("like this");
  });
});

// The coverage bots write their table as HTML, on one line, inside the fold —
// so it never met the pipe-table rule and arrived on screen as its own source.
describe("an HTML table from a bot", () => {
  const T = '<table><tr><th>File</th><th>Stmts</th><th>Cover</th></tr><tbody>'
    + '<tr><td><a href="https://github.com/acme/orbit/blob/abc/constants.py">constants.py</a></td><td>17</td><td>100%</td></tr>'
    + '<tr><td><b>TOTAL</b></td><td><b>2471</b></td><td><b>75%</b></td></tr>'
    + '</tbody></table>';

  test("it becomes a table block, not a paragraph of tags", () => {
    const t = parseBody(T).find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(t).toBeDefined();
    expect(t.head).toEqual(["File", "Stmts", "Cover"]);
    expect(t.rows).toHaveLength(2);
  });

  test("a link in a cell stays a link", () => {
    const t = parseBody(T).find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(t.rows[0]![0]).toContain("constants.py");
    expect(t.rows[0]![0]).toContain("<a href=");
  });

  test("bold in a cell stays bold", () => {
    const t = parseBody(T).find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(t.rows[1]![0]).toContain("<strong>TOTAL</strong>");
  });

  test("a cell cannot smuggle markup in", () => {
    // The cells are rendered with dangerouslySetInnerHTML, so this is the one
    // that matters: everything goes through renderInline, which escapes first.
    const t = parseBody('<table><tr><td><img src=x onerror="alert(1)"></td></tr></table>')
      .find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(JSON.stringify(t)).not.toContain("onerror");
    expect(JSON.stringify(t)).not.toContain("<img");
  });

  test("a javascript: href in a cell becomes text, never an anchor", () => {
    const t = parseBody('<table><tr><td><a href="javascript:alert(1)">x</a></td></tr></table>')
      .find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(JSON.stringify(t)).not.toContain("<a href");
    expect(JSON.stringify(t)).not.toContain("javascript:");
    expect(t.head).toEqual(["x"]);
  });

  test("a table with no <th> promotes its first row rather than losing it", () => {
    const t = parseBody("<table><tr><td>a</td><td>b</td></tr><tr><td>1</td><td>2</td></tr></table>")
      .find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(t.head).toEqual(["a", "b"]);
    expect(t.rows).toEqual([["1", "2"]]);
  });

  test("text after </table> is not swallowed", () => {
    const blocks = parseBody("<table><tr><td>a</td></tr></table>trailing words");
    expect(JSON.stringify(blocks)).toContain("trailing words");
  });
});

/*
 * The two reasons a review comment read worse here than on GitHub.
 *
 * Both were reported by comparing our rendering of the SAME comment with
 * GitHub's, side by side: «we don't have those bullets, nor the right
 * indentation, nor the right line breaks... spacing matters a lot for
 * readability».
 *
 * Neither was a parse failure, which is why nothing in this suite noticed: the
 * markdown was read correctly and then drawn with the bullets switched off and
 * the newlines spent.
 */
describe("the two ways the prose was flattened", () => {
  test("puts the list marker back that the CSS reset took away", async () => {
    /*
     * The panel's stylesheet set the indent and coloured `::marker`, but never
     * undid Tailwind preflight's `ul,ol{list-style:none}` — so there was no
     * marker for the colour to land on and a finding list arrived as text
     * nudged 1.5em right. Measured in the built app afterwards: ul `disc`,
     * nested `circle`, ol `decimal`, padding-left 18.75px.
     */
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(panel).toContain(".agx-md ul{list-style:disc}");
    expect(panel).toContain(".agx-md ul ul{list-style:circle}");
    expect(panel).toContain(".agx-md ol{list-style:decimal}");
    // The task list draws its own box and must stay bare.
    expect(panel).toContain(".agx-md .agx-task{list-style:none;padding-left:0}");
  });

  test("keeps a single newline as a break, the way GitHub does", async () => {
    // GitHub renders comment bodies with hard breaks on. Joining with a space
    // ran "Review Summary" into the stats line under it, and every other stat
    // line in the body lost its shape the same way.
    const { parseBody } = await import("../src/lib/prBody.ts");
    const blocks = parseBody("Findings summary\n2 blocking. 1 minor.", undefined);
    const para = blocks.find((b) => b.kind === "para") as { html: string } | undefined;
    expect(para?.html).toContain("<br>");
    expect(para?.html).not.toContain("Findings summary 2 blocking");
  });
});

/*
 * Three shapes the list parser got wrong, all invisible until the markers were
 * switched back on and then confidently wrong. Found by the correctness audit,
 * each with the parser's own output as the evidence.
 */
describe("lists, once they had markers again", () => {
  test("a blank line between steps does not restart the numbering", () => {
    // Was three separate `<ol>`s, and an `<ol>` with no `start` begins at 1 —
    // so a three-step procedure read "1. / 1. / 1.". Loose lists are how every
    // review bot writes a procedure.
    const blocks = parseBody("1. First\n\n2. Second\n\n3. Third\n");
    const lists = blocks.filter((b) => b.kind === "list");
    expect(lists.length).toBe(1);
    expect((lists[0] as { items: unknown[] }).items.length).toBe(3);
  });

  test("a blank line followed by prose still ends the list", () => {
    const blocks = parseBody("1. First\n2. Second\n\nAnd then a paragraph.\n");
    expect(blocks.filter((b) => b.kind === "list").length).toBe(1);
    expect(blocks.filter((b) => b.kind === "para").length).toBe(1);
  });

  test("a bullet nested under a numbered step keeps its own marker", () => {
    // Flat, every `<li>` of the `<ol>` took a number: the two sub-bullets became
    // steps 3 and 4 and pushed the real step 3 to 5.
    const blocks = parseBody("1. One\n2. Two\n   - note\n   - other\n3. Three\n");
    const list = blocks.find((b) => b.kind === "list") as { items: { depth: number; ordered?: boolean }[] };
    expect(list.items.map((i) => i.ordered)).toEqual([true, true, false, false, true]);
    expect(list.items.map((i) => i.depth)).toEqual([0, 0, 1, 1, 0]);
  });
});

describe("a machine's marker on a line with words on it", () => {
  test("a sticky comment keeps its words", () => {
    // The old pattern backtracked from the first `<!--` to the LAST `-->`, so a
    // one-line sticky comment arrived as an author, a timestamp and nothing.
    expect(JSON.stringify(parseBody("<!-- sticky:cov -->Coverage is 75%<!-- /sticky -->")))
      .toContain("Coverage is 75%");
  });

  test("a line that is only markers is still dropped", () => {
    expect(parseBody("<!-- only -->").length).toBe(0);
  });

  test("and one in the middle of a sentence is still left alone", () => {
    // Somebody showing the syntax typed that on purpose; an edge marker is a
    // bot's handle on its own comment.
    expect(JSON.stringify(parseBody("Write <!-- like this --> to hide a note"))).toContain("like this");
  });
});

describe("nesting is about order, not about how far", () => {
  const depths = (body: string) => {
    const list = parseBody(body).find((b) => b.kind === "list") as { items: { depth: number }[] };
    return list.items.map((i) => i.depth);
  };

  test("two sublists indented differently sit at the SAME level", () => {
    /*
     * A real bug, not a test gap, found by the tests audit. Depth came from
     * dividing the indent by two, so a four-space sublist was filed a level
     * below a two-space one — and a body that indents some of its sublists by
     * two and some by four, which is most of them, nested the second inside the
     * first. GitHub draws them level.
     */
    expect(depths("- a\n  - b\n- c\n    - d")).toEqual([0, 1, 0, 1]);
    expect(depths("- a\n   - b\n- c\n  - d")).toEqual([0, 1, 0, 1]);
  });

  test("going deeper still steps, and coming back still returns", () => {
    expect(depths("- a\n  - b\n    - c\n- d")).toEqual([0, 1, 2, 0]);
    expect(depths("- a\n    - b\n        - c")).toEqual([0, 1, 2]);
  });

  test("a tab is an indent like any other", () => {
    expect(depths("- a\n\t- b")).toEqual([0, 1]);
  });
});

/*
 * A REAL CHECKBOX, GITHUB'S OWN WAY.
 *
 * "GitHub already does that without hand-editing the body, by marking it as a
 * real checkbox" — clicking a box in the description used to mean
 * opening the whole editor to hand-edit `[ ]` into `[x]`. `toggleChecklistItem`
 * is the other half: given the raw body and which box (by position, the same
 * way the renderer numbers them), flip exactly that one character and leave
 * everything else — the wording, the blank lines, a table above it — byte for
 * byte where it was.
 */
describe("toggling a checklist item", () => {
  test("flips the Nth box, counting top to bottom", () => {
    const body = "- [ ] one\n- [x] two\n- [ ] three";
    expect(toggleChecklistItem(body, 0)).toBe("- [x] one\n- [x] two\n- [ ] three");
    expect(toggleChecklistItem(body, 1)).toBe("- [ ] one\n- [ ] two\n- [ ] three");
    expect(toggleChecklistItem(body, 2)).toBe("- [ ] one\n- [x] two\n- [x] three");
  });

  test("leaves the rest of the body untouched, wording and all", () => {
    const body = "## Checklist\n\nSome context first.\n\n- [ ] a thing to do\n- [x] already done\n\nMore prose after.";
    const next = toggleChecklistItem(body, 0);
    expect(next).toBe("## Checklist\n\nSome context first.\n\n- [x] a thing to do\n- [x] already done\n\nMore prose after.");
  });

  test("counts a nested box right after its parent, not after its siblings", () => {
    // Document order, depth-first — the same order the renderer numbers them
    // in, since a nested item is the one immediately below its parent in the
    // raw text.
    const body = "- [ ] parent\n  - [ ] child\n- [x] sibling";
    expect(toggleChecklistItem(body, 1)).toBe("- [ ] parent\n  - [x] child\n- [x] sibling");
  });

  test("skips a line that only looks like one — no brackets, no space after them", () => {
    const body = "- [ ] real one\n- [ ]missing the space\n- not a list item [ ] at all\n- [ ] real two";
    // Index 1 must land on "real two", not on either impostor.
    expect(toggleChecklistItem(body, 1)).toBe("- [ ] real one\n- [ ]missing the space\n- not a list item [ ] at all\n- [x] real two");
  });

  test("an index past the last box changes nothing", () => {
    const body = "- [ ] only one";
    expect(toggleChecklistItem(body, 5)).toBe(body);
  });

  test("a plain list item with no checkbox is not counted", () => {
    const body = "- [ ] box\n- plain item, not a task\n- [x] another box";
    expect(toggleChecklistItem(body, 1)).toBe("- [ ] box\n- plain item, not a task\n- [ ] another box");
  });
});
