/*
 * The card list's search, filters and sections, as decisions.
 *
 * Everything here runs over the cards already loaded — the screen spends no
 * request on narrowing — so the fixtures are the shape a board read returns,
 * with invented names.
 */
import { describe, expect, test } from "bun:test";
import type { ListStatus } from "../../shared/providers.ts";
import {
  activeFacets, boardCount, cardSections, flatItems, matchesFacets, narrowed, NO_CARD_FILTERS, openAllView, personOptions,
  prCount, scopeCards, searchMatches, shownCount, statusOptions, truncatedNote, whyEmpty, type BoardCard, type CardFilters,
} from "../src/model/cardBoard.ts";

const ada = { id: 1001, name: "ada", initials: "A", me: true };
const bob = { id: 1002, name: "bob", initials: "B" };
const cy = { id: 1003, name: "cy", initials: "C" };

const card = (over: Partial<BoardCard> & { id: string }): BoardCard => ({
  title: "A card", status: "To Do", statusKind: "open", ...over,
});
const f = (over: Partial<CardFilters> = {}): CardFilters => ({ ...NO_CARD_FILTERS, ...over });

const cards: BoardCard[] = [
  card({ id: "1", customId: "ORBIT-1042", title: "Add retry to sync", status: "In Review", people: [ada, bob], list: "Orbit Sprint" }),
  card({ id: "2", customId: "ORBIT-1050", title: "Fix avatar crop", status: "In Review", people: [cy] }),
  card({ id: "3", customId: "ORBIT-1080", title: "Rate limit headers", status: "In Progress", people: [bob] }),
  card({ id: "4", customId: "ORBIT-1090", title: "Write the runbook", status: "To Do" }),
  card({ id: "5", customId: "ORBIT-1001", title: "Ship the thing", status: "Done", statusKind: "done", people: [ada] }),
];
const order: ListStatus[] = [
  { status: "To Do", type: "open", orderindex: 0 },
  { status: "In Progress", type: "custom", orderindex: 1, color: "#1d6bd6" },
  { status: "In Review", type: "custom", orderindex: 2, color: "#6b4fc9" },
  { status: "Done", type: "done", orderindex: 3 },
];

describe("search", () => {
  test("an empty box keeps every card; it is not the matcher's 'matches nothing'", () => {
    expect(cards.filter((c) => searchMatches(c, ""))).toHaveLength(5);
    expect(cards.filter((c) => searchMatches(c, "   "))).toHaveLength(5);
  });
  test("reads the title, the id, the list, the status and the people, every word", () => {
    const ids = (q: string) => cards.filter((c) => searchMatches(c, q)).map((c) => c.id);
    expect(ids("retry")).toEqual(["1"]);
    expect(ids("orbit-1050")).toEqual(["2"]);
    expect(ids("sprint")).toEqual(["1"]);
    expect(ids("in review")).toEqual(["1", "2"]);
    expect(ids("bob")).toEqual(["1", "3"]);
    expect(ids("bob retry")).toEqual(["1"]);
  });
});

describe("facets", () => {
  test("no facet keeps everything; values in one facet are OR-ed, facets are AND-ed", () => {
    expect(cards.filter((c) => matchesFacets(c, NO_CARD_FILTERS))).toHaveLength(5);
    const ids = (x: CardFilters) => cards.filter((c) => matchesFacets(c, x)).map((c) => c.id);
    expect(ids(f({ statuses: ["In Review", "In Progress"] }))).toEqual(["1", "2", "3"]);
    expect(ids(f({ statuses: ["In Review"], people: ["1002"] }))).toEqual(["1"]);
  });
  test("a person is matched by id, so two people sharing initials stay apart", () => {
    const twins = [card({ id: "a", people: [{ id: 7, name: "dee", initials: "D" }] }), card({ id: "b", people: [{ id: 8, name: "dee", initials: "D" }] })];
    expect(twins.filter((c) => matchesFacets(c, f({ people: ["8"] }))).map((c) => c.id)).toEqual(["b"]);
  });
  test("Unassigned is a person of its own and joins the others", () => {
    const ids = (x: CardFilters) => cards.filter((c) => matchesFacets(c, x)).map((c) => c.id);
    expect(ids(f({ people: ["none"] }))).toEqual(["4"]);
    expect(ids(f({ people: ["none", "1003"] }))).toEqual(["2", "4"]);
  });
  test("a card known only by assignee names still filters by name", () => {
    const old = card({ id: "x", assignees: ["ada"] });
    expect(matchesFacets(old, f({ people: ["ada"] }))).toBe(true);
    expect(matchesFacets(old, f({ people: ["none"] }))).toBe(false);
  });
  test("the badge counts facets that narrow, not the grouping switch", () => {
    expect(activeFacets(NO_CARD_FILTERS)).toBe(0);
    expect(activeFacets(f({ group: false }))).toBe(0);
    expect(activeFacets(f({ statuses: ["To Do", "Done"] }))).toBe(1);
    expect(activeFacets(f({ statuses: ["To Do"], people: ["none"] }))).toBe(2);
  });
});

describe("Open / All and the counts", () => {
  test("Open drops the done cards; All keeps them", () => {
    expect(openAllView(cards, "", NO_CARD_FILTERS, false).counts).toEqual({ open: 4, all: 5 });
  });
  test("both numbers follow the search and the facets, so they match what the list would show", () => {
    expect(openAllView(cards, "ada", NO_CARD_FILTERS, false).counts).toEqual({ open: 1, all: 2 });
    expect(openAllView(cards, "", f({ statuses: ["Done"] }), false).counts).toEqual({ open: 0, all: 1 });
  });
  test("narrowed is what the list draws", () => {
    expect(narrowed(cards, "", NO_CARD_FILTERS, true).map((c) => c.id)).toEqual(["1", "2", "3", "4"]);
    expect(narrowed(cards, "", NO_CARD_FILTERS, false)).toHaveLength(5);
    expect(narrowed(cards, "", f({ people: ["1001"] }), true).map((c) => c.id)).toEqual(["1"]);
  });
  test("'Show N cards' counts the draft over the same Open/All and search", () => {
    expect(shownCount(cards, f({ statuses: ["In Review"] }), "", true)).toBe(2);
    expect(shownCount(cards, NO_CARD_FILTERS, "", false)).toBe(5);
    expect(shownCount(cards, f({ people: ["1002"] }), "retry", true)).toBe(1);
  });
});

describe("the sheet's options", () => {
  test("statuses follow the list's own order, each with its count, and skip the empty ones", () => {
    const scope = scopeCards(cards, "", true);
    expect(statusOptions(scope, order).map((s) => [s.status, s.count])).toEqual([["To Do", 1], ["In Progress", 1], ["In Review", 2]]);
    expect(statusOptions(scope, order)[1]!.color).toBe("#1d6bd6");
  });
  test("a status picked earlier stays listed at zero, so it can be un-picked", () => {
    const scope = scopeCards(cards, "", true);
    expect(statusOptions(scope, order, ["Done"]).map((s) => s.status)).toEqual(["To Do", "In Progress", "In Review", "Done"]);
  });
  test("a status the list does not name comes after the named ones, in the order met", () => {
    const odd = [card({ id: "q", status: "Parked" }), card({ id: "r", status: "To Do" })];
    expect(statusOptions(odd, order).map((s) => s.status)).toEqual(["To Do", "Parked"]);
  });
  test("people: me first under my own word, the rest by how many cards, unassigned counted apart", () => {
    const { people, unassigned } = personOptions(cards);
    expect(people.map((p) => [p.key, p.name, p.count])).toEqual([["1001", "Me", 2], ["1002", "bob", 2], ["1003", "cy", 1]]);
    expect(people[0]!.sub).toBe("ada");
    expect(unassigned).toBe(1);
  });
  test("a person picked earlier stays listed at zero, named from the whole board", () => {
    const scope = cards.filter((c) => c.id === "4");
    expect(personOptions(scope, ["1003"], cards).people.map((p) => [p.key, p.name, p.count])).toEqual([["1003", "cy", 0]]);
    expect(personOptions(scope, [], cards).people).toEqual([]);
  });
});

describe("sections", () => {
  test("grouped: in the list's status order, each section with its cards and colour", () => {
    const s = cardSections(narrowed(cards, "", NO_CARD_FILTERS, false), order, true);
    expect(s.map((x) => [x.label, x.cards.length])).toEqual([["To Do", 1], ["In Progress", 1], ["In Review", 2], ["Done", 1]]);
    expect(s[2]!.color).toBe("#6b4fc9");
  });
  test("ungrouped: one section with no heading, in the order loaded", () => {
    const s = cardSections(cards, order, false);
    expect(s).toHaveLength(1);
    expect(s[0]!.label).toBeNull();
    expect(s[0]!.cards.map((c) => c.id)).toEqual(["1", "2", "3", "4", "5"]);
  });
  test("a board with no list statuses orders sections as they are met", () => {
    expect(cardSections(cards, [], true).map((x) => x.label)).toEqual(["In Review", "In Progress", "To Do", "Done"]);
  });
  test("a status' own colour is read off the card when the list does not give one", () => {
    const s = cardSections([card({ id: "c", status: "Parked", statusColor: "#888888" })], order, true);
    expect(s[0]!.color).toBe("#888888");
  });
  test("flat items: a header then its cards, the last card of a section marked", () => {
    const items = flatItems(cardSections(cards.slice(0, 3), order, true));
    expect(items.map((i) => (i.kind === "head" ? `# ${i.section.label}` : i.card.id))).toEqual(["# In Progress", "3", "# In Review", "1", "2"]);
    expect(items.filter((i) => i.kind === "card").map((i) => (i.kind === "card" ? i.last : null))).toEqual([true, false, true]);
  });
  test("no headings, no header items", () => {
    expect(flatItems(cardSections(cards, order, false)).every((i) => i.kind === "card")).toBe(true);
  });
});

describe("why a list is empty", () => {
  test("says what is narrowing it, most specific first", () => {
    expect(whyEmpty(cards, "zzz", NO_CARD_FILTERS, true)).toBe("search");
    expect(whyEmpty(cards, "", f({ statuses: ["Done"] }), true)).toBe("filters");
    expect(whyEmpty(cards, "zzz", f({ statuses: ["Done"] }), true)).toBe("search");
    expect(whyEmpty(cards, "retry", NO_CARD_FILTERS, true)).toBeNull();
    expect(whyEmpty([card({ id: "d", status: "Done", statusKind: "done" })], "", NO_CARD_FILTERS, true)).toBe("all-done");
    expect(whyEmpty([], "", NO_CARD_FILTERS, true)).toBe("none");
  });
});

describe("pull request count", () => {
  const withField = (value: string): BoardCard => card({
    id: "p", custom: [{ id: "f", name: "GitHub PR", value, kind: "url" }],
  });
  test("a count the phone learned from the card wins", () => {
    expect(prCount(withField("https://github.com/acme/orbit/pull/101"), 3)).toBe(3);
    expect(prCount(card({ id: "p" }), 0)).toBe(0);
  });
  test("without one, the pull requests the card's own GitHub field names", () => {
    expect(prCount(withField("https://github.com/acme/orbit/pull/101"), undefined)).toBe(1);
    expect(prCount(withField("https://github.com/acme/orbit/pull/101 https://github.com/acme/orbit/pull/101, https://github.com/acme/web/pull/7"), undefined)).toBe(2);
  });
  test("the field as the tracker hands it over: a short value and the address in href, counted once", () => {
    const real = card({ id: "p", custom: [{ id: "f", name: "GitHub Url", value: "github.com/acme/orbit/pull/101", href: "https://github.com/acme/orbit/pull/101", kind: "url" }] });
    expect(prCount(real, undefined)).toBe(1);
  });
  test("a link that is not a pull request is not counted, and nothing known is null not zero", () => {
    expect(prCount(withField("https://github.com/acme/orbit/issues/4"), undefined)).toBeNull();
    expect(prCount(card({ id: "p" }), undefined)).toBeNull();
  });
});

describe("a board read cut off at the limit", () => {
  test("says so once, and the counts are floors", () => {
    expect(truncatedNote(200, true)).toBe("Showing the first 200 cards; narrow the board to see the rest.");
    expect(boardCount(37, true)).toBe("37+");
  });
  test("a whole board says nothing and keeps plain numbers", () => {
    expect(truncatedNote(12, false)).toBeNull();
    expect(boardCount(12, false)).toBe(12);
  });
});

describe("the board screen reads", () => {
  test("only the newest read may land, and another computer starts from nothing", async () => {
    const src = await Bun.file(new URL("../app/(tabs)/tasks.tsx", import.meta.url)).text();
    const body = src.slice(src.indexOf("const load = useCallback("), src.indexOf("useEffect(() => { setTasks(null); setLocal(null)"));
    expect(body).toContain("++asked.current");
    expect(body.match(/mine !== asked\.current/g)?.length).toBe(2);
    expect(src).toMatch(/host\?\.origin[\s\S]{0,400}setChosen\(null\)/);
  });
});
