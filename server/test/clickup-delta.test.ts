/*
 * Markdown to the ops ClickUp renders.
 *
 * Compared as WHOLE op arrays rather than "does it contain bold", because every
 * way this can fail is a key name: `text` against `insert`, a missing
 * `attributes: {}`, a flat `list` instead of a nested one. All of those post
 * happily — the API answers 200 with a comment id — and the comment shows up
 * empty or unstyled on the card, where nobody can see the difference until a
 * person looks at it.
 *
 * The randomness is injected so the block ids are comparable: one call per id,
 * counting from `block-0000000000`.
 */
import { describe, expect, test } from "bun:test";
import { looksPlain, markdownToDelta, parseInline } from "../src/clickupDelta.ts";
import { commentMarkdown } from "../src/clickup.ts";

/** Deterministic ids: block-0000000000, block-0000000001, … */
function counter() {
  let n = 0;
  return (len: number) => String(n++).padStart(len, "0");
}
const md2 = (md: string) => markdownToDelta(md, counter());

describe("inline", () => {
  test("plain text is one op, with attributes present and empty", () => {
    expect(parseInline("just words")).toEqual([{ text: "just words", attributes: {} }]);
  });

  test("bold, italic, strike and code each get their attribute", () => {
    expect(parseInline("**b**")).toEqual([{ text: "b", attributes: { bold: true } }]);
    expect(parseInline("*i*")).toEqual([{ text: "i", attributes: { italic: true } }]);
    expect(parseInline("~~s~~")).toEqual([{ text: "s", attributes: { strike: true } }]);
    expect(parseInline("`c`")).toEqual([{ text: "c", attributes: { code: true } }]);
  });

  test("attributes nest the way the syntax does", () => {
    expect(parseInline("**bold and *both* back**")).toEqual([
      { text: "bold and ", attributes: { bold: true } },
      { text: "both", attributes: { bold: true, italic: true } },
      { text: " back", attributes: { bold: true } },
    ]);
  });

  test("a link carries the url, and formatting inside it survives", () => {
    expect(parseInline("see [the **PR**](https://example.test/1)")).toEqual([
      { text: "see ", attributes: {} },
      { text: "the ", attributes: { link: "https://example.test/1" } },
      { text: "PR", attributes: { link: "https://example.test/1", bold: true } },
    ]);
  });

  /* A comment with a stray asterisk must post with a stray asterisk. Failing
     the whole write over one is the wrong trade: the words are the point. */
  test("an unclosed delimiter stays as characters", () => {
    expect(parseInline("2 * 3 = 6")).toEqual([{ text: "2 * 3 = 6", attributes: {} }]);
    expect(parseInline("a `b")).toEqual([{ text: "a `b", attributes: {} }]);
  });
});

describe("blocks", () => {
  test("a heading closes its line with the level", () => {
    expect(md2("## Qué pasó")).toEqual([
      { text: "Qué pasó", attributes: {} },
      { text: "\n", attributes: { header: 2, "block-id": "block-0000000000" } },
    ]);
  });

  test("bullets, numbers and checkboxes are all `list`, nested not flat", () => {
    const ops = md2("- one\n1. two\n- [x] done\n- [ ] todo");
    expect(ops.filter((o) => o.text === "\n").map((o) => (o.attributes as Record<string, unknown>).list)).toEqual([
      { list: "bullet" }, { list: "ordered" }, { list: "checked" }, { list: "unchecked" },
    ]);
    // The text of a checkbox line is the item, not the `[x]`.
    expect(ops[4]).toEqual({ text: "done", attributes: {} });
  });

  test("an indented item carries its depth", () => {
    const ops = md2("- top\n  - under");
    expect((ops[3]!.attributes as Record<string, unknown>)).toEqual({ list: { list: "bullet" }, indent: 1, "block-id": "block-0000000001" });
  });

  test("a quote's attribute is an empty object, not true", () => {
    const ops = md2("> careful");
    expect((ops[1]!.attributes as Record<string, unknown>).blockquote).toEqual({});
  });

  test("a fenced block is one op per line, with the language", () => {
    expect(md2("```bash\nmake test\nmake lint\n```")).toEqual([
      { text: "make test", attributes: {} },
      { text: "\n", attributes: { "code-block": { "code-block": "bash" }, "block-id": "block-0000000000" } },
      { text: "make lint", attributes: {} },
      { text: "\n", attributes: { "code-block": { "code-block": "bash" }, "block-id": "block-0000000001" } },
    ]);
  });

  test("a fence with no language gets ClickUp's own default", () => {
    const ops = md2("```\nplain\n```");
    expect((ops[1]!.attributes as Record<string, unknown>)["code-block"]).toEqual({ "code-block": "css" });
  });

  test("a rule is a typed op and carries no attributes at all", () => {
    expect(md2("---")).toEqual([{ type: "divider", text: "---" }]);
  });

  test("a table uses `insert` inside and `text` nowhere", () => {
    const [table] = md2("| a | b |\n|---|---|\n| 1 | 2 |");
    const t = table!["table-embed"] as { rows: unknown[]; columns: unknown[]; cells: Record<string, { content: { insert: string }[] }> };
    expect(table!.type).toBe("table-embed");
    expect(t.rows).toHaveLength(2);
    expect(t.columns).toHaveLength(2);
    expect(t.cells["1:1"]!.content).toEqual([{ insert: "a" }, { insert: "\n" }]);
    expect(t.cells["2:2"]!.content[0]).toEqual({ insert: "2" });
    expect(JSON.stringify(table)).not.toContain('"text"');
  });

  /* The four traps from the workspace's own verification, as one assertion over
     a document that uses everything. */
  test("every text op carries attributes, and nothing uses `insert` outside a table", () => {
    const ops = md2("# h\n\ntext **b**\n\n- item\n\n> q\n\n```js\nx\n```\n\n---");
    for (const o of ops) {
      if (o.type === "divider") { expect(o.attributes).toBeUndefined(); continue; }
      expect(o.attributes).toBeDefined();
      expect(typeof o.text).toBe("string");
      expect(o).not.toHaveProperty("insert");
    }
    // Every closing newline is diffable.
    for (const o of ops.filter((x) => x.text === "\n")) {
      expect(String((o.attributes as Record<string, unknown>)["block-id"])).toMatch(/^block-\w{10}$/);
    }
  });
});

/*
 * The strongest check available without writing to a real card: what we send is
 * what our own reader — which was built against comments ClickUp wrote — turns
 * back into the markdown it started as.
 */
describe("the round trip through the reader", () => {
  const cases = [
    "# Heading\n",
    "A line with **bold**, *italic* and `code`.\n",
    "- one\n- two\n",
    "> a quote\n",
    "```bash\nmake test\n```\n",
    "See [the PR](https://example.test/1).\n",
  ];
  /* Ordered lists are the one thing that does not come back character for
     character, and correctly so: the wire format carries "this is an ordered
     item" and no index, so the reader numbers them itself. */
  test("an ordered list keeps its kind, and the numbers are the reader's", () => {
    expect(commentMarkdown(md2("1. first\n2. second\n") as Parameters<typeof commentMarkdown>[0]).trim())
      .toBe("1. first\n1. second");
  });

  for (const md of cases) {
    test(JSON.stringify(md.slice(0, 28)), () => {
      const back = commentMarkdown(md2(md) as Parameters<typeof commentMarkdown>[0]);
      expect(back.trim()).toBe(md.trim());
    });
  }
});

describe("looksPlain", () => {
  test("true for a note, false for anything the converter would style", () => {
    expect(looksPlain("on it, taking a look now")).toBe(true);
    expect(looksPlain("**on it**")).toBe(false);
    expect(looksPlain("- on it")).toBe(false);
    expect(looksPlain("see [here](https://example.test)")).toBe(false);
  });
});

/*
 * An `@` that actually arrives.
 *
 * `@Name` as characters is just characters: the card shows what looks like a
 * mention, and the person named is never told — "the mention didn't work…
 * it has to look like this for it to actually notify them". A mention is an op of
 * its own, and this is the shape, read off a comment written in ClickUp itself
 * and confirmed against the API's own documentation:
 *
 *   { "type": "tag", "user": { "id": 1234567 }, "text": "@Ada Lovelace" }
 *
 * Verified live against a real workspace before this test was written: posted
 * through `commentOn`, read back with `type: "tag"`, and the workspace resolved
 * the id — its own flattening of the comment carries the person's name, which a
 * plain-text `@` never produces.
 */
const PEOPLE = [
  { id: 11, name: "Ada Lovelace", email: "ada@orbit.test", initials: "AL" },
  { id: 22, name: "Ada", initials: "A" },
];
const mention = (md: string) => markdownToDelta(md, counter(), PEOPLE);

describe("mentions", () => {
  test("the name comes out as a tag op, and the rest stays text", () => {
    expect(mention("@Ada Lovelace LGTM")).toEqual([
      { type: "tag", user: { id: 11, username: "Ada Lovelace", email: "ada@orbit.test", initials: "AL" }, text: "@Ada Lovelace" },
      { text: " LGTM", attributes: {} },
      { text: "\n", attributes: { "block-id": "block-0000000000" } },
    ]);
  });

  test("a tag op carries no attributes, which every other op must have", () => {
    // Both are true at once and both matter: the API rejects neither, and a
    // comment with the wrong one renders wrong rather than failing.
    const [tag, words] = mention("@Ada Lovelace hi");
    expect(tag).not.toHaveProperty("attributes");
    expect(words).toHaveProperty("attributes");
  });

  test("the longest name wins, so a surname is not left behind as text", () => {
    // With "Ada" matched first, "@Ada Lovelace" would post as a mention of the
    // wrong person followed by the word "Lovelace".
    expect(mention("@Ada Lovelace ping")[0]).toMatchObject({ user: { id: 11 } });
    expect(mention("@Ada ping")[0]).toMatchObject({ user: { id: 22 } });
  });

  test("an address is not somebody being called", () => {
    expect(mention("write to ada@orbit.test about it")).toEqual([
      { text: "write to ada@orbit.test about it", attributes: {} },
      { text: "\n", attributes: { "block-id": "block-0000000000" } },
    ]);
  });

  test("and neither is a name inside code", () => {
    /* `@Ada` in a backticked run is a string somebody is quoting — a handle, a
       config key — not a person to wake up. */
    const ops = mention("try `@Ada Lovelace` in the config");
    expect(ops.some((o) => (o as { type?: string }).type === "tag")).toBe(false);
  });

  test("nobody named, or no roster: the `@` stays a character", () => {
    expect(markdownToDelta("@Somebody Else hi", counter())).toEqual([
      { text: "@Somebody Else hi", attributes: {} },
      { text: "\n", attributes: { "block-id": "block-0000000000" } },
    ]);
  });

  test("two people in one sentence are two mentions", () => {
    const ops = mention("@Ada Lovelace and @Ada, both");
    expect(ops.filter((o) => (o as { type?: string }).type === "tag").map((o) => (o as { user: { id: number } }).user.id))
      .toEqual([11, 22]);
  });
});
