/*
 * The link block belongs to the trackers that can put a pull request on a
 * card, and to none that cannot. ClickUp's list of kinds is what it was; a
 * second tracker adds to it by name rather than by widening the list every
 * screen already reads.
 */
import { expect, test } from "bun:test";
import { BLOCK_INFO, blockInfoFor, blockRefusal, blocksProblem, hasExtras, planOf } from "../../shared/stepBlocks.ts";
import type { StepBlock } from "../../shared/providers.ts";

test("Jira offers the link and no custom field; ClickUp's list is untouched", () => {
  expect(blockInfoFor("jira").map((b) => b.type)).toEqual(["move", "unassign", "assign", "comment", "link"]);
  expect(blockInfoFor("clickup")).toBe(BLOCK_INFO);
  expect(BLOCK_INFO.map((b) => b.type)).not.toContain("link");
});

test("a tracker without the kind refuses it by name, and one block of a kind is the rule here too", () => {
  expect(blockRefusal("move", [], "link")).toBe("“link” is not a block.");
  expect(blockRefusal("move", [], "link", "jira")).toBeNull();
  expect(blockRefusal("move", [{ type: "link" }], "link", "jira")).toMatch(/Already in this step/);
  expect(blockRefusal("move", [], "field", "jira")).toBe("“field” is not a block.");
  for (const t of ["move", "menu", "merge"] as const) expect(blockRefusal(t, [], "link", "jira")).toBeNull();
});

test("a list with a link is a problem for ClickUp's rule and not for Jira's", () => {
  const blocks: StepBlock[] = [{ type: "move", statusNames: ["Ready"] }, { type: "link" }];
  expect(blocksProblem("move", blocks)).toMatch(/block 2 \(link\)/);
  expect(blocksProblem("move", blocks, "jira")).toBeNull();
});

test("the plan says there is a link, and a link is a request of its own", () => {
  const p = planOf<string | number>("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [{ type: "move", statusNames: ["Ready"] }, { type: "link" }] });
  expect(p.link).toBe(true);
  expect(hasExtras(p)).toBe(true);
  const none = planOf<string | number>("move", { enabled: true, statusNames: [], assign: { who: "none" }, blocks: [{ type: "move", statusNames: ["Ready"] }] });
  expect("link" in none).toBe(false);
  expect(hasExtras(none)).toBe(false);
});
