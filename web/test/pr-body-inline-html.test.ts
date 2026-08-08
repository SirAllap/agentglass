// Two things a comment writes that the panel printed as source.
//
// Both were reported from the app, side by side with GitHub's rendering of the
// same comment:
//
//   1. a coverage bot signs off with
//      `<i>report-only-changed-files is enabled…</i>` and the angle brackets
//      were on screen. Comment bodies carry a little inline HTML as a matter of
//      course — `<i>`, `<b>`, `<code>`, `<br>`, `<sub>`, `<sup>`, `<kbd>`,
//      `<del>` — and GitHub renders all of it.
//   2. a review writes `delta since 8c362cc → c9ed653` and neither sha was a
//      link, so the commit sitting two clicks away in the Commits tab could not
//      be opened from the sentence that named it.
//
// The escaping half of this file is the half with teeth. `renderInline`'s
// output is handed to `dangerouslySetInnerHTML`, and the string it is given was
// written by anyone who can comment on a public pull request — so an allowlist
// that leaks is a cross-site scripting bug, not a rendering one. Every attack
// below is fed through the real function and asserted on its real output.
//
// And on its real output as a PARSER reads it, which is the correction this
// file needed. Every "stays escaped" claim here used to be a regular expression
// matched against the output string — precisely the shape of check that the
// stored-XSS blocker in this same code walked past. That string looked fine: it
// was full of `&quot;` and `https://` and nothing that reads as an attack, and
// real Chrome built an `onmouseover` attribute out of it. So the question is
// no longer "does this string look like a tag" but "what did the parser build",
// asked through `domOf` — see htmlAttrs.ts, which `pr-body-xss.test.ts` had
// first.
import { describe, expect, test } from "bun:test";
import { parseBody, renderInline, type MdBlock } from "../src/lib/prBody.ts";
import { domOf, urlScheme, type Built } from "./htmlAttrs.ts";

const REPO = "acme/orbit";

/** Every string a tree of blocks would put on screen. */
function allHtml(blocks: MdBlock[]): string {
  return blocks.map((b) => {
    if (b.kind === "details") return `${b.summary}\n${allHtml(b.blocks)}`;
    if (b.kind === "list") return b.items.map((i) => i.html).join("\n");
    if (b.kind === "table") return [...b.head, ...b.rows.flat()].join("\n");
    if (b.kind === "code" || b.kind === "suggestion") return b.text;
    return "html" in b ? b.html : "";
  }).join("\n");
}

describe("the inline HTML a comment is allowed to keep", () => {
  test("the coverage bot's sign-off is italic, not its own source", () => {
    // Measured before the allowlist existed, on this exact line:
    //   "&lt;i&gt;report-only-changed-files is enabled…&lt;/i&gt;"
    const html = renderInline("<i>report-only-changed-files is enabled. No files were changed during this commit :)</i>", REPO);
    expect(html).toContain("<i>report-only-changed-files is enabled.");
    expect(html).toContain("</i>");
    expect(html).not.toContain("&lt;i&gt;");
  });

  test("each tag on the list survives, and nothing else does", () => {
    for (const t of ["b", "strong", "i", "em", "code", "del", "sub", "sup", "kbd"]) {
      const html = renderInline(`a <${t}>x</${t}> b`);
      expect(html).toBe(`a <${t}>x</${t}> b`);
    }
    // Inline, but not on the list: no attribute of theirs is worth honouring
    // and `style` alone is enough to cover the page.
    for (const t of ["span", "font", "abbr", "small", "mark", "u"]) {
      const html = renderInline(`a <${t}>x</${t}> b`);
      expect(html).toBe(`a &lt;${t}&gt;x&lt;/${t}&gt; b`);
    }
  });

  test("<br> is a break in all three spellings people write it", () => {
    expect(renderInline("one<br>two<br/>three<br />four")).toBe("one<br>two<br>three<br>four");
  });

  test("a whole comment renders, with the inline HTML in place", () => {
    const html = allHtml(parseBody([
      "Coverage stayed flat.",
      "",
      "Press <kbd>Ctrl</kbd>+<kbd>K</kbd> to jump. H<sub>2</sub>O, x<sup>2</sup>.",
      "",
      "<i>report-only-changed-files is enabled.</i>",
    ].join("\n"), REPO));
    expect(html).toContain("<kbd>Ctrl</kbd>");
    expect(html).toContain("<sub>2</sub>");
    expect(html).toContain("<sup>2</sup>");
    expect(html).toContain("<i>report-only-changed-files is enabled.</i>");
    expect(html).not.toContain("&lt;");
  });
});

/*
 * The allowlist is the whole safety argument, so each way of widening it gets
 * its own case. The rule it pins: the pattern is the exact characters of a tag
 * from the list and nothing else — no attribute, no capital, no space, no
 * variant — and it runs on the already-escaped string, so anything it does not
 * recognise is text by default rather than by omission.
 */

/** The nine on the list, plus the void one: every element a comment that is not
 *  a link is allowed to put in the tree. */
const INERT = ["b", "strong", "i", "em", "code", "del", "sub", "sup", "kbd", "br"];
/** The three an anchor is built with. There is no fourth. */
const ANCHOR_ATTRS = ["href", "target", "rel"];

/**
 * The claim every guard below makes, answered by a real HTML parser: whatever
 * the comment wrote, the tree that comes out of it has nothing in it that can
 * run, load or navigate anywhere but where it says.
 *
 * Anchors are allowed here because `renderInline` builds them on purpose; what
 * is checked is that they carry their own three attributes and no fourth, and
 * that the href names a scheme a click can survive.
 */
async function inert(html: string): Promise<Built> {
  const built = await domOf(html);
  expect(built.tags.filter((t) => !INERT.includes(t) && t !== "a")).toEqual([]);
  // The whole class in one line: an attribute nobody wrote on purpose. This is
  // what the old regex could not see — `<i onmouseover=…>` reads as `<i` to a
  // pattern looking for tag names.
  expect(built.attrs.filter((a) => !ANCHOR_ATTRS.includes(a.name.toLowerCase()))).toEqual([]);
  for (const a of built.attrs) {
    if (a.name.toLowerCase() !== "href") continue;
    // Decoded before the scheme is read: `&#106;avascript:` is a script URL and
    // an assertion on the written characters would not know it. The href rides
    // along so a failure names the link that went wrong.
    expect({ href: a.value, scheme: urlScheme(a.value) })
      .toEqual({ href: a.value, scheme: expect.stringMatching(/^https?$/) });
  }
  return built;
}

describe("what the allowlist refuses", () => {
  /**
   * Nothing here is a link, so nothing here may be an element at all beyond the
   * nine inert ones — and not one of those may carry a single attribute.
   */
  const stays = async (raw: string): Promise<string> => {
    const html = renderInline(raw, REPO);
    const built = await domOf(html);
    expect(built.tags.filter((t) => !INERT.includes(t))).toEqual([]);
    expect(built.attrs).toEqual([]);
    return html;
  };

  test("an image with an onerror handler stays text", async () => {
    const html = await stays('<img src=x onerror=alert(1)>');
    expect(html).toBe("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("an allowlisted tag carrying an attribute is not allowlisted", async () => {
    // The one that matters: `i` is on the list, so a pattern sloppy about
    // attributes would hand this straight to the DOM.
    const html = await stays('<i onmouseover="alert(1)">hover</i>');
    expect(html).not.toContain("<i");
    expect(html).toContain("&lt;i onmouseover=");
    expect(await stays('<b class="x">y</b>')).toContain("&lt;b class=");
    expect(await stays("<code data-x=1>y</code>")).toContain("&lt;code data-x=1&gt;");
    expect(await stays("<br onload=alert(1)>")).toContain("&lt;br onload=alert(1)&gt;");
    // All nine, not only the three that were reported. The allowlist is one
    // loop over one list, so a hole in it is a hole in every name on it — and
    // `<sup>` is as good a place to hang a handler as `<i>`.
    for (const t of ["b", "strong", "i", "em", "code", "del", "sub", "sup", "kbd"]) {
      expect(await stays(`<${t} onmouseover="alert(1)">x</${t}>`)).toContain(`&lt;${t} onmouseover=`);
      expect(await stays(`<${t} style="position:fixed;inset:0">x</${t}>`)).toContain(`&lt;${t} style=`);
    }
  });

  test("<script> and friends stay text", async () => {
    expect(await stays("<script>alert(1)</script>")).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(await stays("<style>body{display:none}</style>")).toContain("&lt;style&gt;");
    expect(await stays('<iframe src="https://evil.example.com"></iframe>')).toContain("&lt;iframe");
    expect(await stays("<svg onload=alert(1)>")).toContain("&lt;svg");
  });

  test("a javascript: anchor is never an anchor", async () => {
    const html = await stays('<a href="javascript:alert(1)">click</a>');
    expect(html).not.toContain("<a");
    expect(html).not.toContain("javascript:alert(1)</a>");
    // and the markdown spelling of the same trick, which the link rule refuses
    expect(renderInline("[click](javascript:alert(1))")).not.toContain("<a");
  });

  test("a capital letter is a different tag", async () => {
    // GitHub would italicise this. Kept out on purpose: the list is exact
    // strings, and every variant a match tolerates is one more thing the
    // pattern has to be right about. A bot writing `<I>` is not a real case.
    const html = await stays("<I>shout</I>");
    expect(html).toBe("&lt;I&gt;shout&lt;/I&gt;");
  });

  test("whitespace before the name does not open a tag", async () => {
    expect(await stays("< i>gap</i>")).toBe("&lt; i&gt;gap&lt;/i&gt;");
    expect(await stays("<\ti>tab</i>")).toContain("&lt;");
  });

  test("an unclosed tag stays text — it does not take the rest of the block", async () => {
    expect(await stays("<i>oops")).toBe("&lt;i&gt;oops");
    expect(await stays("closed too soon</b>")).toBe("closed too soon&lt;/b&gt;");
    // Two opens and one close is still unbalanced.
    expect(await stays("<b>a<b>b</b>")).toContain("&lt;b&gt;a&lt;b&gt;b&lt;/b&gt;");
    // Balanced but back to front is a fragment too: the opener at the end of it
    // would run on into whatever comes next.
    expect(await stays("</b>a<b>")).toBe("&lt;/b&gt;a&lt;b&gt;");
  });

  test("a code span quotes its tags rather than running them", async () => {
    // The one place a `<i>` must stay visible: somebody writing ABOUT the tag.
    const html = renderInline("write `<i>x</i>` for italics");
    expect(html).toContain("<code>&lt;i&gt;x&lt;/i&gt;</code>");
    expect(html).not.toContain("<code><i>");
    // The parser agrees: one `<code>`, and no italics anywhere in the tree.
    expect((await domOf(html)).tags).toEqual(["code"]);
  });

  test("an allowlisted tag cannot shelter a forbidden one", async () => {
    const html = await stays("<code><script>alert(1)</script></code>");
    expect(html).toBe("<code>&lt;script&gt;alert(1)&lt;/script&gt;</code>");
  });

  test("a tag cannot be reassembled out of two", async () => {
    // The classic against a strip-then-render sanitiser. Nothing is stripped
    // here — everything is escaped and a listed few are put back — so the
    // halves never meet.
    expect(await stays("<scr<b>ipt>alert(1)</b>")).not.toContain("<script");
  });

  test("a table cell keeps the same rule", async () => {
    // Cells go to `dangerouslySetInnerHTML` too, through the same function.
    const t = parseBody('<table><tr><td><img src=x onerror="alert(1)"></td></tr></table>', REPO)
      .find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
    expect(JSON.stringify(t)).not.toContain("onerror");
    expect(JSON.stringify(t)).not.toContain("<img");
    expect(await domOf([...t.head, ...t.rows.flat()].join("\n"))).toEqual({ tags: [], attrs: [] });
  });
});

/*
 * The places this code CONSTRUCTS output rather than escaping it.
 *
 * That is where the stored-XSS blocker lived, and it is the only shape of bug
 * an allowlist cannot prevent: `renderInline` does not hand the href through,
 * it BUILDS an attribute with somebody else's string in the middle of it. Same
 * for the link text, an image's two attributes, a table cell and a `<summary>`.
 * So the payloads below are aimed at the seams of those templates, and every
 * one of them is answered by the parser rather than by reading the string.
 */
describe("the places that construct instead of escape", () => {
  test("the scheme check reads what a browser reads, not what is written", () => {
    // The one guard here that is not the parser's own answer, so it gets its
    // own case: `HTMLRewriter` hands back an attribute value as SOURCE TEXT,
    // and every one of these spellings is the same link once a browser is done
    // with it.
    expect(urlScheme("https://acme.example/x")).toBe("https");
    expect(urlScheme("javascript:alert(1)")).toBe("javascript");
    expect(urlScheme("&#106;avascript:alert(1)")).toBe("javascript");
    expect(urlScheme("&#x6a;avascript:alert(1)")).toBe("javascript");
    expect(urlScheme("java\tscript:alert(1)")).toBe("javascript");
    expect(urlScheme(" javascript:alert(1)")).toBe("javascript");
    expect(urlScheme("data:text/html,x")).toBe("data");
    expect(urlScheme("/relative/x")).toBeNull();
    expect(urlScheme("//evil.example/x")).toBeNull();
  });

  const payloads: [string, string][] = [
    ["a double quote straight in the href",
      '[t](https://acme.example/a"onmouseover=alert(1))'],
    ["a single quote, for the attributes people write without double ones",
      "[t](https://acme.example/a'onmouseover=alert(1))"],
    ["a URL inside a URL — a wiki link, a redirect, a tracking wrapper",
      "[docs](https://acme.example/wiki/Foo_(https://x.example/onmouseover=globalThis.PWN=1+)"],
    ["an entity that is decoded back to a quote before anything escapes it",
      '[t](https://acme.example/?a=1&quot;onmouseover=alert(1))'],
    ["the numeric spelling of that quote, with a space after it",
      '[t](https://acme.example/?a=&#34;&#32;onmouseover=alert(1))'],
    ["a backtick pair, which is lifted out first and put back last",
      '[t](https://acme.example/a`" onmouseover=alert(1) `)'],
    ["a tab in the middle of the URL",
      "[t](https://acme.example/a\tonmouseover=alert(1))"],
    ["a newline in the middle of the URL",
      "[t](https://acme.example/a\nonmouseover=alert(1))"],
    ["markup in the link TEXT, which goes into the template unquoted",
      "[<img src=x onerror=alert(1)>](https://acme.example/)"],
    ["a closing anchor in the link text",
      "[a</a><img src=x onerror=alert(1)>](https://acme.example/)"],
    ["markup that IS on the allowlist, in the link text",
      "[<b>x</b> and **y** and `<i>z</i>`](https://acme.example/)"],
    ["a bare URL with a quote in it, which no markdown link rule ever sees",
      'look at https://acme.example/a"onload="alert(1) here'],
    ["a bare URL pressed against a tag",
      "https://acme.example/x<b>y</b>"],
    ["a sha and an issue reference, whose hrefs are built from the body too",
      "delta since 8c362cc, see acme/orbit#12 and other.repo/x#9"],
  ];

  for (const [name, body] of payloads) {
    test(name, async () => { await inert(renderInline(body, REPO)); });
  }

  test("a code span inside a URL lands in the attribute VALUE, where it is text", async () => {
    // Worth pinning because it is genuinely surprising: backticks are lifted
    // out before anything is escaped and put back at the very end — AFTER the
    // href has been built — so the `<code>` this produces is written inside the
    // attribute. Quoted, so the parser reads it as characters: one element,
    // three attributes, and no `<code>` anywhere in the tree.
    const built = await inert(renderInline("[t](https://acme.example/`x`)", REPO));
    expect(built.tags).toEqual(["a"]);
    expect(built.attrs.find((a) => a.name === "href")?.value).toBe("https://acme.example/<code>x</code>");
  });

  test("only http and https ever become an anchor at all", async () => {
    for (const body of [
      "[t](javascript:alert(1))",
      "[t](JavaScript:alert(1))",
      "[t](javascript&colon;alert(1))",
      "[t](java&Tab;script:alert(1))",
      "[t](data:text/html;base64,PHN2Zz4=)",
      "[t](vbscript:msgbox(1))",
      "[t](//evil.example/x)",
      "[t](/relative/x)",
    ]) {
      const built = await inert(renderInline(body, REPO));
      expect(built.tags).not.toContain("a");
    }
  });

  test("a link still works, and still points where it said", async () => {
    const built = await inert(renderInline("[docs](https://acme.example/guide)", REPO));
    expect(built.attrs.find((a) => a.name === "href")?.value).toBe("https://acme.example/guide");
    expect(built.attrs.find((a) => a.name === "rel")?.value).toContain("noreferrer");
  });
});

describe("an image's two attributes", () => {
  const imageOf = (body: string) =>
    parseBody(body, REPO).find((b) => b.kind === "image") as Extract<MdBlock, { kind: "image" }> | undefined;

  test("alt is data all the way to the screen, so markup in it is inert", async () => {
    const body = '![a" onerror="alert(1)](https://acme.example/x.png)';
    const img = imageOf(body)!;
    expect(img.src).toBe("https://acme.example/x.png");
    // Kept verbatim ON PURPOSE. It never joins the HTML string: it is a React
    // `alt` prop and a `<figcaption>` text child, both escaped on the way out,
    // and no `renderInline` and no `dangerouslySetInnerHTML` ever sees it.
    expect(img.alt).toBe('a" onerror="alert(1)');
    expect(await domOf(allHtml(parseBody(body, REPO)))).toEqual({ tags: [], attrs: [] });
  });

  test("the HTML spelling of an image is read the same way", async () => {
    const body = '<img alt="a&quot; onerror=&quot;alert(1)" src="https://acme.example/x.png">';
    const img = imageOf(body)!;
    expect(img.src).toBe("https://acme.example/x.png");
    expect(urlScheme(img.src)).toBe("https");
    expect(await domOf(allHtml(parseBody(body, REPO)))).toEqual({ tags: [], attrs: [] });
  });

  test("a src that is not http(s) is not an image at all", async () => {
    for (const body of [
      "![x](javascript:alert(1))",
      "![x](data:text/html;base64,PHN2Zz4=)",
      '<img src="data:text/html,<script>alert(1)</script>">',
      '<img src="javascript:alert(1)">',
      "![x](//evil.example/x.png)",
    ]) {
      expect(imageOf(body)).toBeUndefined();
      // And the line it fell through to is a paragraph, which is escaped.
      expect(await domOf(allHtml(parseBody(body, REPO)))).toEqual({ tags: [], attrs: [] });
    }
  });

  test("credentials in an image URL are carried, and refused where it matters", () => {
    // `https://user:pw@…` is a legal URL and this parser keeps it, because the
    // decision is not the parser's: `api.prAssetUrl` hands the whole thing to
    // the server, and `assetAllowed` there answers with a host allowlist —
    // https only, and only GitHub's own image hosts. A URL like this one is
    // never fetched. What is pinned here is that the client does not quietly
    // rewrite it into something the allowlist would accept.
    const img = imageOf("![x](https://user:pw@acme.example/x.png)")!;
    expect(img.src).toBe("https://user:pw@acme.example/x.png");
    expect(urlScheme(img.src)).toBe("https");
  });
});

describe("a table cell, which is markdown inside HTML inside markdown", () => {
  const tableOf = (body: string) =>
    parseBody(body, REPO).find((b) => b.kind === "table") as Extract<MdBlock, { kind: "table" }>;
  const cellHtml = (t: Extract<MdBlock, { kind: "table" }>) => [...t.head, ...t.rows.flat()].join("\n");

  test("a markdown cell gets exactly what a paragraph gets", async () => {
    const t = tableOf("| a | b |\n|---|---|\n| <img src=x onerror=alert(1)> | [t](javascript:alert(1)) |");
    expect(await domOf(cellHtml(t))).toEqual({ tags: [], attrs: [] });
  });

  test("an HTML cell's anchor keeps its href and loses everything else", async () => {
    const t = tableOf('<table><tr><td><a href="https://acme.example/" onmouseover="alert(1)">t</a></td></tr></table>');
    const built = await inert(cellHtml(t));
    expect(built.tags).toEqual(["a"]);
    expect(built.attrs.map((a) => a.name)).toEqual(ANCHOR_ATTRS);
  });

  test("a cell's link text is not a way to write an attribute", async () => {
    // `htmlCellToMarkdown` BUILDS `[text](href)` out of two strings a stranger
    // wrote, and `renderInline` then reads that as markdown. So the text is a
    // second seam, and this is the payload aimed at it. (Measured while writing
    // this: a `]` in the text does re-parent the link — the anchor ends up
    // pointing at the URL the TEXT named. Both strings are the same author's,
    // so nothing crosses a boundary, and it is left unpinned here because the
    // shape is a defect to fix rather than a contract to keep.)
    for (const cell of [
      '<td><a href="https://acme.example/x">a](javascript:alert(1))</a></td>',
      '<td><a href="https://acme.example/x">a" onmouseover="alert(1)</a></td>',
      '<td><a href="javascript:alert(1)">click</a></td>',
      '<td><a href="https://acme.example/x" target="_self" onclick="alert(1)">t</a></td>',
    ]) {
      const t = tableOf(`<table><tr>${cell}</tr></table>`);
      await inert(cellHtml(t));
    }
  });

  test("a cell cannot smuggle a tag through the strip", async () => {
    const t = tableOf("<table><tr><td><scr<b>ipt>alert(1)</b>ipt></td></tr></table>");
    expect(cellHtml(t)).not.toContain("<script");
    await inert(cellHtml(t));
  });
});

describe("a <details> summary, which is text and must stay text", () => {
  const summaryOf = (body: string) =>
    (parseBody(body, REPO).find((b) => b.kind === "details") as Extract<MdBlock, { kind: "details" }>).summary;

  test("markup in a summary is removed rather than shown", () => {
    // Empty after the strip, so the fold keeps its default name instead of
    // being titled with the wreckage.
    expect(summaryOf("<details><summary><img src=x onerror=alert(1)></summary>body</details>")).toBe("Details");
  });

  test("a tag reassembled out of two halves does not survive either", () => {
    // `<scr` + `<b>` + `ipt>`: removing the inner tag closes the outer one up,
    // which is why the strip repeats until the string stops changing.
    const summary = summaryOf("<details><summary><scr<b>ipt>alert(1)</b></summary>body</details>");
    expect(summary).toBe("alert(1)");
    expect(summary).not.toContain("<");
  });

  test("a quote in a summary cannot become an attribute, because a summary is never HTML", async () => {
    // It is a React text child. This asks the harder question anyway — what a
    // parser would build if it ever were HTML — because "it is only ever text"
    // is a claim about a component two files away.
    const summary = summaryOf('<details><summary>a" onmouseover="alert(1)</summary>body</details>');
    expect(summary).not.toContain("<");
    expect(await domOf(summary)).toEqual({ tags: [], attrs: [] });
  });

  test("the fold's contents are parsed, and get the same answer as anything else", async () => {
    const blocks = parseBody("<details><summary>Report</summary>\n\n<img src=x onerror=alert(1)>\n\n[t](https://acme.example/x)\n</details>", REPO);
    const fold = blocks.find((b) => b.kind === "details") as Extract<MdBlock, { kind: "details" }>;
    expect(fold.summary).toBe("Report");
    await inert(allHtml(fold.blocks));
  });
});

describe("a bare commit sha", () => {
  test("the reported sentence links both shas", () => {
    const html = renderInline("delta since 8c362cc → c9ed653", REPO);
    expect(html).toContain('href="https://github.com/acme/orbit/commit/8c362cc"');
    expect(html).toContain('href="https://github.com/acme/orbit/commit/c9ed653"');
    expect(html).toContain("<code>8c362cc</code>");
  });

  test("the href is the one the panel already intercepts", async () => {
    // `PrPanel` opens a commit link inside the app when the sha belongs to this
    // pull request, and `shaFromHref` is what decides. It reads the href as a
    // URL and insists on all of it — github.com, this repository, `/commit/` or
    // `/pull/N/commits/`, then the sha and nothing after it — so the plain
    // GitHub commit URL is what has to come out of here, with no query, no
    // fragment and no trailing slash to spoil the match.
    //
    // Asserted by calling that very function rather than by restating its
    // pattern here — a test of a copy keeps passing after the original changes
    // its mind. (`PrPanel` itself cannot be imported: it reaches `location` at
    // module scope and there is no DOM in this suite. The rule does not live
    // there, which is why this works.)
    const { shaFromHref } = await import("../src/lib/commitLink.ts");
    for (const raw of ["delta since 8c362cc", "delta since 8c362cca1b2c3d4e5f60718293a4b5c6d7e8f90"]) {
      const href = renderInline(raw, REPO).match(/href="([^"]+)"/)?.[1] ?? "";
      expect(shaFromHref(href, REPO)).toBe(raw.split(" ").pop()!);
    }
    // The same href with the wrong repository is somebody else's commit, and
    // the panel says so — the click goes to GitHub instead of the Commits tab.
    const href = renderInline("delta since 8c362cc", REPO).match(/href="([^"]+)"/)?.[1] ?? "";
    expect(shaFromHref(href, "other/thing")).toBeNull();
  });

  test("with no repo in hand there is nowhere to point, so it stays text", () => {
    expect(renderInline("delta since 8c362cc → c9ed653")).toBe("delta since 8c362cc → c9ed653");
  });

  test("the shapes a review actually writes", () => {
    const linked = (s: string) => (renderInline(s, REPO).match(/\/commit\/([0-9a-f]+)/g) ?? []);
    // Measured before: only the first of these five linked anything.
    expect(linked("delta since 8c362cc → c9ed653")).toEqual(["/commit/8c362cc", "/commit/c9ed653"]);
    expect(linked("delta since **8c362cc** → **c9ed653**")).toEqual(["/commit/8c362cc", "/commit/c9ed653"]);
    expect(linked("range 8c362cc..c9ed653")).toEqual(["/commit/8c362cc", "/commit/c9ed653"]);
    expect(linked("[8c362cc]")).toEqual(["/commit/8c362cc"]);
    expect(linked("(8c362cc)")).toEqual(["/commit/8c362cc"]);
    // A full 40-character sha, and its short form on screen.
    const full = renderInline("at 8c362cca1b2c3d4e5f60718293a4b5c6d7e8f90", REPO);
    expect(full).toContain("/commit/8c362cca1b2c3d4e5f60718293a4b5c6d7e8f90");
    expect(full).toContain("<code>8c362cc</code>");
  });
});

/*
 * What is NOT a sha. Every one of these is hex-shaped text that a comment is
 * full of, and a link on any of them points at a commit that does not exist —
 * which is worse than plain text, because it looks answerable.
 */
describe("the hex this refuses to call a sha", () => {
  const links = (s: string) => (renderInline(s, REPO).match(/\/commit\//g) ?? []).length;

  test("hex inside a code span", () => {
    expect(links("`8c362cc` is the base")).toBe(0);
    expect(renderInline("`8c362cc`", REPO)).toBe("<code>8c362cc</code>");
  });

  test("hex inside a fenced code block", () => {
    const blocks = parseBody("```\ngit show 8c362cc\n```", REPO);
    expect(allHtml(blocks)).toBe("git show 8c362cc");
    expect(allHtml(blocks)).not.toContain("<a");
  });

  test("a hex colour", () => {
    expect(links("border: #deadbe and #deadbeef and #8c362cc")).toBe(0);
  });

  test("hex inside a longer identifier", () => {
    expect(links("build-8c362cc-linux")).toBe(0);
    expect(links("run_8c362cc")).toBe(0);
    expect(links("8c362ccz")).toBe(0);
    expect(links("artifact8c362cc")).toBe(0);
  });

  test("a number that happens to be hex-shaped", () => {
    // `1754500000` linked as a commit and was displayed as `1754500` — a live
    // epoch in a bot's footer, turned into a link to nothing.
    expect(links("took 1234567 rows in 1754500000 ms")).toBe(0);
  });

  test("a word that happens to be hex-shaped", () => {
    // `defaced` linked as a commit. So would `deadbeef`, `effaced`, `beefcafe`.
    expect(links("the defaced cache and the deadbeef marker")).toBe(0);
  });

  test("too short, and too long", () => {
    expect(links("8c362c is six")).toBe(0);
    // A sha256 — a lockfile digest — is 64 characters and must not have its
    // tail linked as if it were a commit.
    expect(links("sha256 e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")).toBe(0);
  });

  test("hex already inside a link", () => {
    // An anchor inside an anchor is not a link at all — the browser closes the
    // first one and the click lands somewhere nobody chose.
    const html = renderInline("[8c362cc report](https://ci.example.com/x)", REPO);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("/commit/");
    // and the bare-URL form of the same thing
    const bare = renderInline("https://ci.example.com/runs/8c362cca1b2c3d4", REPO);
    expect(bare.match(/<a /g)).toHaveLength(1);
    expect(bare).not.toContain("/commit/");
  });

  test("an issue reference inside a link does not nest either", () => {
    // Same bug, same fix: measured before, `[see #123](https://…)` came out as
    // an `<a>` inside an `<a>`.
    const html = renderInline("[see #123](https://ci.example.com/x)", REPO);
    expect(html.match(/<a /g)).toHaveLength(1);
    expect(html).not.toContain("/issues/123");
    // A `#123` on its own is still linked.
    expect(renderInline("fixes #123", REPO)).toContain("/issues/123");
  });

  test("hex inside a <code> tag the comment wrote itself", () => {
    // The allowlist renders this as code, and code is quoted text: the same
    // answer backticks get.
    const html = renderInline("delta since <code>8c362cc</code>", REPO);
    expect(html).toBe("delta since <code>8c362cc</code>");
  });
});
