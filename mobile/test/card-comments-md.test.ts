/*
 * A card's comments are markdown, and the screen printed them raw: `**3**`,
 * backticks and `![img](url)` arrived as typed. There is no renderer in this
 * project, so the rule is asserted against the source of the screen.
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../app/card/[id].tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join("\n");

test("a comment and its replies go through Md, not a bare Text", () => {
  expect(code).toContain("<Md text={c.text}");
  expect(code).toContain("<Md text={r.text}");
  expect(code).not.toMatch(/>\{c\.text\}<\/Text>/);
  expect(code).not.toMatch(/>\{r\.text\}<\/Text>/);
});

/*
 * The request budget on this screen (ClickUp allows ~100 a minute per token):
 * a card read is 3 requests + 1 per thread, and a move or an assignment used to
 * follow its write with one. The write already answers with the card.
 */
const fn = (name: string): string => {
  const at = code.indexOf(`const ${name} = useCallback(`);
  expect(at).toBeGreaterThan(-1);
  const end = code.indexOf("\n  }, [", at);
  return code.slice(at, end);
};

test("a move and an assignment do not re-read the card when the write carried it", () => {
  for (const [name, carried] of [["move", "outcome.task"], ["apply", "outcome.task"]] as const) {
    const body = fn(name);
    expect(body).toContain(`if (!${carried}) await load()`);
    expect(body).not.toMatch(/\n\s*await load\(\);/);
  }
});

test("a comment still reads again: the comments are what changed", () => {
  expect(fn("comment")).toMatch(/\n\s*await load\(\);/);
});

test("opening draws what is held, and reads only when it is stale", () => {
  expect(code).toContain("void load(false)");
  expect(code).toContain("cards.fresh(cardKey(host.origin, id), CARD_FRESH_MS)");
  expect(code).toContain("lists.fresh(card.listId!, LIST_FRESH_MS)");
});

test("a linked pull request asks with its card's field and checkout, and says whose it is", () => {
  expect(code).toContain("cardPrsQuery(card, repos)");
  expect(code).toContain("sub={prLine(pr)}");
  expect(code).toContain("<Avatar name={c.who}");
  expect(code).toContain("<Avatar name={r.who}");
});
