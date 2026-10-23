/*
 * The comment converters, Markdown <-> ADF (Cloud) and Markdown <-> wiki
 * markup (Data Center). Pure: no network, no clock.
 *
 * What they are held to: a fixture document read as Markdown and written back
 * is the same document; the same card written in wiki markup reads as the
 * same Markdown; a mention keeps the person's id both ways; anything a site
 * sends that this does not know is read as its words and never throws.
 */
import { describe, expect, test } from "bun:test";
import { adfToMarkdown, adfToWiki, editableBody, markdownToAdf, markdownToWiki, wikiToMarkdown, type AdfNode } from "../src/jiraAdf.ts";
import richDescription from "./fixtures/jira/description-rich.json";
import wiki from "./fixtures/jira/wiki.json";
import issues from "./fixtures/jira/issues.json";

const RICH_MD = [
  "## Problem",
  "",
  "The export stalls when the board has more than **200 cards**. See the [runbook](https://docs.acme.example/runbook) and ask @Grace Sample.",
  "",
  "- Reproduce with the large board",
  "- Compare against the small board",
  "",
  "```ts",
  "await exportBoard(board, { limit: 200 });",
  "```",
  "",
  "| Board | Seconds |",
  "| --- | --- |",
  "| small | 2 |",
].join("\n");

const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const text = (t: string, ...marks: string[]): AdfNode => (marks.length ? { type: "text", text: t, marks: marks.map((type) => ({ type })) } : { type: "text", text: t });
const doc = (...content: AdfNode[]) => ({ type: "doc", version: 1, content });

describe("ADF to Markdown and back", () => {
  test("the rich fixture reads as Markdown, with its mention beside it", () => {
    const r = adfToMarkdown(richDescription);
    expect(r.text).toBe(RICH_MD);
    expect(r.mentions).toEqual([{ id: "acc-0002", name: "Grace Sample" }]);
  });

  test("written back, it is the same document, the mention's account id included", () => {
    const r = adfToMarkdown(richDescription);
    expect(markdownToAdf(r.text, r.mentions)).toEqual(richDescription as never);
  });

  test("the seeded comment round-trips, starting with a mention", () => {
    const body = (issues as { key: string; comments: { body: unknown }[] }[]).find((i) => i.key === "ORBIT-1042")!.comments[0]!.body;
    const r = adfToMarkdown(body);
    expect(r.text).toBe("@Ada Example can you take a look at the retry loop?");
    expect(r.mentions).toEqual([{ id: "acc-0001", name: "Ada Example" }]);
    expect(markdownToAdf(r.text, r.mentions)).toEqual(body as never);
  });

  test("Markdown written, read, and written again is stable", () => {
    const md = "Hi @Ada Example, see **this**, *that*, ~~old~~, `code` and [docs](https://acme.example/x).\nSecond line\n\n1. one\n2. two\n   - nested\n\n```\nlet a = 1;\n```\n\n> quoted\n\n---\n\n# Title";
    const roster = [{ id: "acc-0001", name: "Ada Example" }];
    const once = markdownToAdf(md, roster);
    const read = adfToMarkdown(once);
    expect(markdownToAdf(read.text, read.mentions)).toEqual(once);
    expect(read.mentions).toEqual(roster);
  });
});

describe("Markdown to ADF, node by node", () => {
  test("marks", () => {
    expect(markdownToAdf("**b** *i* `c` ~~s~~").content).toEqual([
      para(text("b", "strong"), text(" "), text("i", "em"), text(" "), text("c", "code"), text(" "), text("s", "strike")),
    ]);
  });

  test("a link keeps its address; a bare address becomes a link; a script address does not", () => {
    expect(markdownToAdf("[docs](https://acme.example/a)").content[0]).toEqual(
      para({ type: "text", text: "docs", marks: [{ type: "link", attrs: { href: "https://acme.example/a" } }] }));
    expect(markdownToAdf("see https://acme.example/b.").content[0]).toEqual(
      para(text("see "), { type: "text", text: "https://acme.example/b", marks: [{ type: "link", attrs: { href: "https://acme.example/b" } }] }, text(".")));
    expect(markdownToAdf("[x](javascript:alert(1))").content[0]).toEqual(para(text("[x](javascript:alert(1))")));
  });

  test("code inside bold keeps only the code mark, which is all ADF allows beside a link", () => {
    expect(markdownToAdf("**a `b`**").content[0]).toEqual(para(text("a ", "strong"), text("b", "code")));
  });

  test("lists, nested, and a numbered list that starts later", () => {
    expect(markdownToAdf("- a\n  - b\n- c").content).toEqual([{
      type: "bulletList",
      content: [
        { type: "listItem", content: [para(text("a")), { type: "bulletList", content: [{ type: "listItem", content: [para(text("b"))] }] }] },
        { type: "listItem", content: [para(text("c"))] },
      ],
    }]);
    expect(markdownToAdf("3. x\n4. y").content[0]).toMatchObject({ type: "orderedList", attrs: { order: 3 } });
  });

  test("a line break inside a paragraph is a hard break", () => {
    expect(markdownToAdf("one\ntwo").content).toEqual([para(text("one"), { type: "hardBreak" }, text("two"))]);
  });

  test("a code block keeps its language and its text verbatim", () => {
    expect(markdownToAdf("```py\nx = '**not bold**'\n```").content).toEqual([
      { type: "codeBlock", attrs: { language: "py" }, content: [{ type: "text", text: "x = '**not bold**'" }] },
    ]);
  });

  test("a heading or a rule inside a list item is flattened, because Jira refuses one there", () => {
    const item = (markdownToAdf("- # big\n- x").content[0] as AdfNode).content![0]!;
    expect(item.content).toEqual([para(text("big"))]);
  });

  test("a mention is only somebody in the roster; inside code, or mid-word, it stays text", () => {
    const roster = [{ id: "acc-0001", name: "Ada" }, { id: "acc-0009", name: "Ada Example" }];
    expect(markdownToAdf("cc @Ada Example", roster).content[0]).toEqual(para(text("cc "), { type: "mention", attrs: { id: "acc-0009", text: "@Ada Example" } }));
    expect(markdownToAdf("cc @Adams", roster).content[0]).toEqual(para(text("cc @Adams")));
    expect(markdownToAdf("`@Ada`", roster).content[0]).toEqual(para(text("@Ada", "code")));
    expect(markdownToAdf("cc @Lin", roster).content[0]).toEqual(para(text("cc @Lin")));
    expect(markdownToAdf("mail ada@acme.example", roster).content[0]).toEqual(para(text("mail ada@acme.example")));
  });

  test("an escaped character is the character", () => {
    expect(markdownToAdf("\\*not\\* \\[x\\]").content[0]).toEqual(para(text("*not* [x]")));
  });

  test("text that looks like syntax is escaped on the way out, and reads back as itself", () => {
    const d = doc(para(text("a *star*, [brackets], ~/code and `ticks`")), para(text("# not a heading")), para(text("1. not a list")));
    const r = adfToMarkdown(d);
    expect(markdownToAdf(r.text).content).toEqual(d.content);
  });

  test("blank input is an empty document", () => {
    expect(markdownToAdf("  \n\n ")).toEqual({ type: "doc", version: 1, content: [] });
  });
});

describe("Markdown that once came out wrong", () => {
  test("a long run of spaces in a heading is read in linear time", () => {
    const t = Date.now();
    markdownToAdf("# a" + " ".repeat(30_000) + "x\n" + "# b" + " ".repeat(30_000) + "c #");
    // Linear is a few milliseconds; quadratic was most of a second, cubic hours.
    expect(Date.now() - t).toBeLessThan(150);
  });

  test("a closing # run needs a space before it; # C# is a heading about C#", () => {
    expect(markdownToAdf("# C#").content[0]).toEqual({ type: "heading", attrs: { level: 1 }, content: [text("C#")] });
    expect(markdownToAdf("## Title ##").content[0]).toEqual({ type: "heading", attrs: { level: 2 }, content: [text("Title")] });
  });

  test("a list item opens with a paragraph, even before a nested list or code", () => {
    const item = (markdownToAdf("- - nested").content[0] as AdfNode).content![0]!;
    expect(item.content![0]).toEqual({ type: "paragraph" });
    expect(item.content![1]!.type).toBe("bulletList");
  });

  test("a fence opened on an item's line keeps its code inside the item", () => {
    const d = markdownToAdf("- ```\ncode\n```\n\nafter");
    expect(d.content.map((n) => n.type)).toEqual(["bulletList", "paragraph"]);
    const item = d.content[0]!.content![0]!;
    expect(item.content).toEqual([{ type: "paragraph" }, { type: "codeBlock", content: [{ type: "text", text: "code" }] }]);
  });

  test("past the nesting cap the words are kept, not dropped", () => {
    const md = Array.from({ length: 12 }, (_, k) => `${"  ".repeat(k)}- level ${k}`).join("\n");
    expect(JSON.stringify(markdownToAdf(md))).toContain("level 11");
  });

  test("a link address may hold parentheses", () => {
    expect(markdownToAdf("[w](https://acme.example/wiki/Foo_(bar))").content[0]).toEqual(
      para({ type: "text", text: "w", marks: [{ type: "link", attrs: { href: "https://acme.example/wiki/Foo_(bar)" } }] }));
  });

  test("inline code never runs across a line", () => {
    expect(markdownToAdf("`a\nb`").content[0]).toEqual(para(text("`a"), { type: "hardBreak" }, text("b`")));
  });

  test("on Data Center, code inside a list item stays on the item's line", () => {
    expect(markdownToWiki("- a\n  ```\n  x {y}\n  ```")).toBe("* a {{x \\{y\\}}}");
  });
});

describe("what a site sends that this does not write", () => {
  test("panels, expands, media, emoji, cards, dates, statuses and task lists read as their words", () => {
    const d = doc(
      { type: "panel", attrs: { panelType: "info" }, content: [para(text("heads up"))] },
      { type: "expand", attrs: { title: "More" }, content: [para(text("hidden"))] },
      { type: "mediaSingle", content: [{ type: "media", attrs: { id: "x", type: "file" } }] },
      para({ type: "emoji", attrs: { shortName: ":smile:", text: "😄" } }, text(" "), { type: "inlineCard", attrs: { url: "https://acme.example/c" } }),
      para({ type: "date", attrs: { timestamp: "1768262400000" } }, text(" "), { type: "status", attrs: { text: "BLOCKED" } }),
      { type: "taskList", content: [{ type: "taskItem", attrs: { state: "DONE" }, content: [text("ship")] }, { type: "taskItem", attrs: { state: "TODO" }, content: [text("test")] }] },
    );
    expect(adfToMarkdown(d).text).toBe([
      "> heads up", "**More**\n\nhidden", "(attachment)", "😄 https://acme.example/c", "2026-01-13 BLOCKED", "- [x] ship\n- [ ] test",
    ].join("\n\n"));
  });

  test("an unknown node is the text inside it, and nothing throws", () => {
    expect(adfToMarkdown(doc({ type: "frobnicate", content: [para(text("kept"))] }, para({ type: "sparkle", content: [text("too")] }))).text).toBe("kept\n\ntoo");
    for (const junk of [null, undefined, 42, "plain words", {}, { content: "no" }, doc({ type: "paragraph", content: [null, 7, { marks: "x" }] as never })]) {
      expect(() => adfToMarkdown(junk)).not.toThrow();
    }
    expect(adfToMarkdown("plain words").text).toBe("plain words");
  });

  test("a document nested past any sense does not take the reader down", () => {
    let n: AdfNode = para(text("deep"));
    for (let k = 0; k < 100_000; k++) n = { type: "blockquote", content: [n] };
    expect(() => adfToMarkdown(doc(n))).not.toThrow();
    // Cut off at a depth, rather than losing the whole document to the fallback.
    expect(adfToMarkdown(doc(n, para(text("after")))).text).toMatch(/^>[\s\S]*\n\nafter$/);
    let m: AdfNode = text("deep");
    for (let k = 0; k < 100_000; k++) m = { type: "sparkle", content: [m] };
    expect(() => adfToMarkdown(doc(para(m)))).not.toThrow();
  });

  test("a link to a script is read as its words", () => {
    const d = doc(para({ type: "text", text: "click", marks: [{ type: "link", attrs: { href: "javascript:alert(1)" } }] }));
    expect(adfToMarkdown(d).text).toBe("click");
  });
});

describe("wiki markup, for Data Center", () => {
  test("the wiki fixture reads as the same Markdown as the ADF one", () => {
    const r = wikiToMarkdown(wiki.description, { grace: "Grace Sample" });
    expect(r.text).toBe(RICH_MD);
    expect(r.mentions).toEqual([{ id: "grace", name: "Grace Sample" }]);
  });

  test("a backslash in monospace is escaped, so it cannot escape the braces that close it", () => {
    const wikiText = markdownToWiki("see `C:\\dir\\` and `{x}`");
    expect(wikiText).toBe("see {{C:\\\\dir\\\\}} and {{\\{x\\}}}");
    expect(wikiToMarkdown(wikiText).text).toBe("see `C:\\dir\\` and `{x}`");
  });

  test("a login nobody named is shown as the login", () => {
    expect(wikiToMarkdown(wiki.comments["30001"]).text).toBe("@ada can you take a look at the retry loop?");
  });

  test("Markdown is written as wiki markup, mentions by login", () => {
    const md = "Hi @Ada Example, **b** *i* ~~s~~ `c` [docs](https://acme.example/x)\n\n- a\n  - b\n1. one\n\n```ts\nx\n```\n\n> q\n\n---\n\n## T\n\n| h1 | h2 |\n| --- | --- |\n| a | b |";
    expect(markdownToWiki(md, [{ id: "ada", name: "Ada Example" }])).toBe([
      "Hi [~ada], *b* _i_ -s- {{c}} [docs|https://acme.example/x]",
      "* a\n** b",
      "# one",
      "{code:ts}\nx\n{code}",
      "{quote}\nq\n{quote}",
      "----",
      "h2. T",
      "||h1||h2||\n|a|b|",
    ].join("\n\n"));
  });

  test("plain text that wiki markup would read as syntax is escaped; a word's own hyphen is not", () => {
    expect(markdownToWiki("a {b} [c] | well-known - dash *x*")).toBe("a \\{b\\} \\[c\\] \\| well-known \\- dash _x_");
    expect(markdownToWiki("\\# not a list")).toBe("\\# not a list");
  });

  test("what is written reads back as what was meant", () => {
    const md = "Hi @Ada Example, **b** *i* `c` [docs](https://acme.example/x) {braces} a-b\n\n- a\n- b\n\n```ts\nx\n```";
    const w = markdownToWiki(md, [{ id: "ada", name: "Ada Example" }]);
    const r = wikiToMarkdown(w, { ada: "Ada Example" });
    expect(markdownToAdf(r.text, r.mentions)).toEqual(markdownToAdf(md, [{ id: "ada", name: "Ada Example" }]));
  });

  test("colours, attachments and other effects read as their words", () => {
    expect(wikiToMarkdown("{color:red}warm{color} !shot.png|thumbnail! +under+ ^up^ ??cite??").text).toBe("warm (attachment) under up *cite*");
  });

  test("an unknown or broken construct never throws", () => {
    for (const junk of ["{code", "[~]", "[|]", "*unclosed", "{quote}never closed", "||", "!", "h7. x", null, 3]) {
      expect(() => wikiToMarkdown(junk)).not.toThrow();
    }
  });

  test("ADF a site wrote can be put in wiki form without throwing", () => {
    expect(() => adfToWiki(markdownToAdf(RICH_MD, [{ id: "grace", name: "Grace Sample" }]))).not.toThrow();
  });
});

describe("whether a stored description can be edited as Markdown", () => {
  const doc = (...content: unknown[]) => ({ type: "doc", version: 1, content });
  const p = (...inline: unknown[]) => ({ type: "paragraph", content: inline });
  const t = (text: string, ...marks: string[]) => ({ type: "text", text, ...(marks.length ? { marks: marks.map((type) => ({ type })) } : {}) });

  test("everything Markdown writes comes back as the same document", () => {
    const md = "## Plan\n\nSome **bold**, *it*, `code`, ~~gone~~ and a [link](https://a.example/x) with @Grace Sample.\n\n1. one\n2. two\n   - nested\n\n> quote\n\n---\n\n```ts\nx\n```\n\nline  \nbreak";
    expect(editableBody(markdownToAdf(md, [{ id: "acc-0002", name: "Grace Sample" }]), 3)).toBe(true);
    expect(editableBody(markdownToWiki(md, [{ id: "grace", name: "Grace Sample" }]), 2)).toBe(true);
  });

  test("nothing at all can be written over", () => {
    for (const empty of [null, undefined, "", doc()]) expect(editableBody(empty, 3)).toBe(true);
    expect(editableBody(null, 2)).toBe(true);
  });

  test("a panel, a table, media, an expand, a task list, an emoji, a smart link, a colour and an underline are not Markdown's", () => {
    const refused: unknown[] = [
      doc({ type: "panel", attrs: { panelType: "info" }, content: [p(t("x"))] }),
      richDescription,
      doc({ type: "mediaSingle", content: [{ type: "media", attrs: { id: "m1", type: "file", collection: "" } }] }),
      doc({ type: "expand", attrs: { title: "More" }, content: [p(t("x"))] }),
      doc({ type: "taskList", attrs: { localId: "1" }, content: [{ type: "taskItem", attrs: { localId: "2", state: "TODO" }, content: [t("x")] }] }),
      doc(p(t("x"), { type: "emoji", attrs: { shortName: ":smile:" } })),
      doc(p({ type: "inlineCard", attrs: { url: "https://a.example/x" } })),
      doc(p({ type: "text", text: "x", marks: [{ type: "textColor", attrs: { color: "#ff0000" } }] })),
      doc(p(t("x", "underline"))),
    ];
    for (const body of refused) expect(editableBody(body, 3)).toBe(false);
  });

  test("a body that is not a document, or is deeper than any reader goes, is refused", () => {
    expect(editableBody("plain", 3)).toBe(false);
    expect(editableBody({ type: "doc", content: "x" }, 3)).toBe(false);
    let deep: unknown = p(t("x"));
    for (let i = 0; i < 20; i++) deep = { type: "blockquote", content: [deep] };
    expect(editableBody(doc(deep), 3)).toBe(false);
  });

  test("on Data Center a table, a panel macro and a non-text body are refused", () => {
    expect(editableBody(wiki.description, 2)).toBe(false);
    expect(editableBody("{panel:title=T}\nbody\n{panel}", 2)).toBe(false);
    expect(editableBody({ type: "doc" }, 2)).toBe(false);
  });
});
