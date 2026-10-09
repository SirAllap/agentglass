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
