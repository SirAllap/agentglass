/*
 * THE ANSWER HIDDEN BY THE QUESTION.
 *
 * Searching a card id lists the cards that MENTION it — and a card that
 * mentions `1042` does not contain `1042` in its title or its own id: the
 * mention is in its body, which is the entire point of that search. The box
 * then filtered the drawer by the same query and removed every one of them.
 * What he saw: a banner saying "2 cards mention 9175 — in Looked up", a Looked
 * up that showed nothing, and the results appearing only after emptying the
 * box by hand. "the whole thing is odd".
 *
 * So the rule, pinned here on the two predicates the panel actually uses: a
 * card the last search produced is not hidden by the query that produced it,
 * and typing again takes that exemption away.
 */
import { describe, expect, test } from "bun:test";
import { matchesQuery } from "../src/lib/boardSearch.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (over: Partial<ProviderTask>): ProviderTask => ({
  id: "c1", customId: "ORBIT-2077", title: "Pagination arrows behave as if you were on page 1",
  url: "", status: "in development", statusKind: "active", tags: [], list: "Miscellaneous",
  assignees: [], people: [],
  ...over,
} as ProviderTask);

/** What the panel does with each row: the filter, or the exemption. */
const visible = (t: ProviderTask, q: string, found: Set<string>) => matchesQuery(t, q) || found.has(t.id);

describe("a search's own results", () => {
  const referring = card({ id: "c2077", customId: "ORBIT-2077" });
  const found = new Set(["c2077"]);

  test("do not match the query — that is why the search existed", () => {
    expect(matchesQuery(referring, "1042"), "if this matched, the bug could not have happened").toBe(false);
  });

  test("are shown anyway, because the search is what put them there", () => {
    expect(visible(referring, "1042", found)).toBe(true);
  });

  test("and typing something else takes the exemption away", () => {
    expect(visible(referring, "1042", new Set())).toBe(false);
  });

  test("while a card that really does match is unaffected", () => {
    expect(visible(card({ id: "c9", title: "Something about 1042" }), "1042", new Set())).toBe(true);
  });
});
