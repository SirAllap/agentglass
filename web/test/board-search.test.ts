/*
 * Searching a board for what the board is showing you.
 *
 * Reported with the card on screen: on a list holding ORBIT-1042, typing
 * `ORBIT-1042` answered "Not on this board. Fetch card from ClickUp" and typing
 * `1042` did the same — while the title found it fine. The row prints the id
 * directly under the title, so the search was contradicting the row.
 *
 * The rule these tests hold: anything the row DRAWS is searchable. Not a list
 * of blessed fields somebody has to remember to extend, which is exactly how
 * the id got left out in the first place.
 */
import { describe, expect, it } from "bun:test";
import { matchesQuery } from "../src/lib/boardSearch.ts";
import type { ProviderTask } from "../../shared/providers.ts";

const card = (over: Partial<ProviderTask> = {}): ProviderTask => ({
  id: "86abc9xyz",
  customId: "ORBIT-1042",
  title: "Support Tool Backend Missing Search Field",
  url: "https://tasks.example.invalid/t/86abc9xyz",
  status: "Ready for engineering",
  statusKind: "open",
  priority: "high",
  due: null,
  updated: 0,
  tags: ["bug-intake", "ai-triaged"],
  list: "Checkout v2",
  assignees: [],
  people: [{ name: "Alejandro Ferrán", initials: "AF" }],
  sprint: "Sprint 42",
  ...over,
});

describe("what the board's search box can find", () => {
  it("finds a card by the id printed on its own row", () => {
    expect(matchesQuery(card(), "ORBIT-1042")).toBe(true);
  });

  it("finds it by the number alone, which is how people type it", () => {
    // The reported case: the prefix is the same on every card, so nobody types
    // it. `includes` on the id is what makes the bare number work.
    expect(matchesQuery(card(), "1042")).toBe(true);
  });

  it("ignores case, in the id as much as in the title", () => {
    expect(matchesQuery(card(), "orbit-1042")).toBe(true);
    expect(matchesQuery(card(), "SEARCH FIELD")).toBe(true);
  });

  it("takes words in any order, because people remember words not phrases", () => {
    /* "Support Tool Backend Missing Search Field" — two remembered words,
       wrong order, still the card you meant. A single `includes` of the whole
       query fails this, and that failure is what sends you to ClickUp's own
       search instead of ours. */
    expect(matchesQuery(card(), "search support")).toBe(true);
    expect(matchesQuery(card(), "field backend")).toBe(true);
  });

  it("needs EVERY word to land, or the filter stops narrowing anything", () => {
    expect(matchesQuery(card(), "support nonexistent")).toBe(false);
  });

  it("finds a card by a tag, a person, the sprint, the status and the list", () => {
    // All five are drawn on the row. None of them were searchable.
    expect(matchesQuery(card(), "bug-intake")).toBe(true);
    expect(matchesQuery(card(), "Ferrán")).toBe(true);
    expect(matchesQuery(card(), "AF")).toBe(true);
    expect(matchesQuery(card(), "Sprint 42")).toBe(true);
    expect(matchesQuery(card(), "ready for engineering")).toBe(true);
    expect(matchesQuery(card(), "Checkout")).toBe(true);
  });

  it("finds it by the internal id, which is what a pasted URL carries", () => {
    expect(matchesQuery(card(), "86abc9xyz")).toBe(true);
  });

  it("keeps every card when nothing is typed, including only spaces", () => {
    // An empty box is not a filter that matches nothing; it is no filter.
    for (const q of ["", "   ", "\t"]) expect(matchesQuery(card(), q), JSON.stringify(q)).toBe(true);
  });

  it("survives a card with the optional halves missing", () => {
    /* `customId` is absent on a workspace without custom ids, `people` on a
       provider that only reports names, `sprint` on a board with no sprints.
       A search box that throws on those is worse than one that misses them. */
    const bare = card({ customId: undefined, people: undefined, sprint: null, list: null, tags: [] });
    expect(matchesQuery(bare, "support")).toBe(true);
    expect(matchesQuery(bare, "orbit")).toBe(false);
  });

  it("matches an assignee reported as a plain name", () => {
    const named = card({ people: undefined, assignees: ["Nuria Castells"] });
    expect(matchesQuery(named, "castells")).toBe(true);
  });
});
