/*
 * The PR list's filter sheet and search, as decisions.
 *
 * Rows are the shape the list really returns (humanReview, checks counts, the
 * card line off the boards); names are invented.
 */
import { describe, expect, test } from "bun:test";
import {
  activeChips, authorOptions, cardStatusOptions, effectiveState, matchesFilters, NO_FILTERS, removeChip,
  shownCount, toggled, withoutCard, type FilterRow, type PrFilters,
} from "../src/model/prFilters.ts";
import { highlight, listPath, searchText, withLocalMatches } from "../src/model/prSearch.ts";
import { STATE_LABEL } from "../src/model/prState.ts";

const card = (status: string, kind: "open" | "done" | "other" = "other") =>
  ({ id: "c1", customId: "ORBIT-1042", title: "t", url: "u", status, statusKind: kind }) as NonNullable<FilterRow["card"]>;

const row = (over: Partial<FilterRow> = {}): FilterRow => ({
  author: "ada", state: "OPEN", isDraft: false,
  checks: { total: 4, success: 4, failure: 0, pending: 0, verdict: "green" } as FilterRow["checks"],
  humanReview: null, card: undefined, ...over,
});
const f = (over: Partial<PrFilters> = {}): PrFilters => ({ ...NO_FILTERS, ...over });

describe("matchesFilters", () => {
  test("no filter keeps everything", () => {
    expect(matchesFilters(row(), NO_FILTERS)).toBe(true);
    expect(matchesFilters(row({ isDraft: true }), NO_FILTERS)).toBe(true);
  });

  test("Review: the humans' verdict, and a bot approval is not one", () => {
    const approved = row({ humanReview: { kind: "approved", who: ["bob"] } });
    const changes = row({ humanReview: { kind: "changes", who: ["bob"] } });
    const mine = row({ humanReview: { kind: "awaiting", who: ["ada"], mine: true } });
    const theirs = row({ humanReview: { kind: "awaiting", who: ["cy"] } });
    const botOnly = row({ humanReview: null, reviewDecision: "APPROVED" } as Partial<FilterRow>);
    expect(matchesFilters(approved, f({ review: "approved" }))).toBe(true);
    expect(matchesFilters(botOnly, f({ review: "approved" }))).toBe(false);
    expect(matchesFilters(changes, f({ review: "changes" }))).toBe(true);
    expect(matchesFilters(approved, f({ review: "changes" }))).toBe(false);
    expect(matchesFilters(mine, f({ review: "needs-me" }))).toBe(true);
    expect(matchesFilters(theirs, f({ review: "needs-me" }))).toBe(false);
  });

  test("Checks: failing outranks running; passing needs checks and none open", () => {
    const red = row({ checks: { total: 4, failure: 1, pending: 1 } as FilterRow["checks"] });
    const running = row({ checks: { total: 4, failure: 0, pending: 2 } as FilterRow["checks"] });
    const none = row({ checks: { total: 0, failure: 0, pending: 0 } as FilterRow["checks"] });
    expect(matchesFilters(red, f({ checks: "failing" }))).toBe(true);
    expect(matchesFilters(red, f({ checks: "running" }))).toBe(false);
    expect(matchesFilters(running, f({ checks: "running" }))).toBe(true);
    expect(matchesFilters(running, f({ checks: "passing" }))).toBe(false);
    expect(matchesFilters(row(), f({ checks: "passing" }))).toBe(true);
    expect(matchesFilters(none, f({ checks: "passing" }))).toBe(false);
  });

  test("Checks not read yet fails open, so the list does not flicker as the rollup lands", () => {
    const unread = row({ checksLoaded: false, checks: undefined });
    expect(matchesFilters(unread, f({ checks: "failing" }))).toBe(true);
  });

  test("Draft and Author", () => {
    expect(matchesFilters(row({ isDraft: true }), f({ draft: "draft" }))).toBe(true);
    expect(matchesFilters(row({ isDraft: true }), f({ draft: "ready" }))).toBe(false);
    expect(matchesFilters(row({ author: "bob" }), f({ authors: ["ada", "bob"] }))).toBe(true);
    expect(matchesFilters(row({ author: "cy" }), f({ authors: ["ada", "bob"] }))).toBe(false);
  });

  test("a card filter leaves out a row with no card unless No card is ticked", () => {
    const inReview = row({ card: card("In Review") });
    const blocked = row({ card: card("Blocked") });
    const bare = row();
    const sel = f({ cardStatus: ["In Review", "Blocked"] });
    expect(matchesFilters(inReview, sel)).toBe(true);
    expect(matchesFilters(blocked, sel)).toBe(true);
    expect(matchesFilters(row({ card: card("Done") }), sel)).toBe(false);
    expect(matchesFilters(bare, sel)).toBe(false);
    expect(matchesFilters(bare, { ...sel, noCard: true })).toBe(true);
    // No card alone means only the rows without one.
    expect(matchesFilters(inReview, f({ noCard: true }))).toBe(false);
    expect(matchesFilters(bare, f({ noCard: true }))).toBe(true);
  });

  test("facets are AND-ed", () => {
    const sel = f({ checks: "failing", cardStatus: ["In Review"] });
    const red = { total: 4, failure: 1, pending: 0 } as FilterRow["checks"];
    expect(matchesFilters(row({ checks: red, card: card("In Review") }), sel)).toBe(true);
    expect(matchesFilters(row({ checks: red, card: card("Done") }), sel)).toBe(false);
    expect(matchesFilters(row({ card: card("In Review") }), sel)).toBe(false);
  });
});

describe("chips", () => {
  test("one chip per active facet, in the sheet's order, none when nothing is chosen", () => {
    expect(activeChips(NO_FILTERS, (s) => STATE_LABEL[s])).toEqual([]);
    const chips = activeChips(f({ checks: "failing", cardStatus: ["In Review", "Blocked"], state: "merged" }), (s) => STATE_LABEL[s]);
    expect(chips.map((c) => c.label)).toEqual(["State: Merged", "Checks: failing", "Card: In Review, Blocked"]);
  });

  test("removing a chip resets only its facet", () => {
    const all = f({ review: "approved", checks: "failing", cardStatus: ["Done"], noCard: true, authors: ["ada"] });
    expect(removeChip(all, "card")).toEqual({ ...all, cardStatus: [], noCard: false });
    expect(removeChip(all, "checks").review).toBe("approved");
    expect(activeChips(removeChip(all, "author"), (s) => STATE_LABEL[s]).some((c) => c.id === "author")).toBe(false);
  });

  test("toggled adds and removes", () => {
    expect(toggled(["a"], "b")).toEqual(["a", "b"]);
    expect(toggled(["a", "b"], "a")).toEqual(["b"]);
  });
});

describe("options from the loaded rows", () => {
  test("statuses with counts, workflow order, and the rows without a card", () => {
    const rows = [
      row({ card: card("Done", "done") }), row({ card: card("In Review") }), row({ card: card("In Review") }),
      row({ card: card("To Do", "open") }), row(), row(),
    ];
    const { statuses, none } = cardStatusOptions(rows);
    expect(statuses).toEqual([
      { status: "To Do", count: 1 }, { status: "In Review", count: 2 }, { status: "Done", count: 1 },
    ]);
    expect(none).toBe(2);
    expect(withoutCard(rows)).toBe(2);
  });

  test("authors, busiest first; repository contributors come in with no rows", () => {
    const rows = [row({ author: "bob" }), row({ author: "ada" }), row({ author: "bob" })];
    expect(authorOptions(rows)).toEqual([{ login: "bob", count: 2 }, { login: "ada", count: 1 }]);
    expect(authorOptions(rows, ["cy", "ada"]).map((a) => a.login)).toEqual(["bob", "ada", "cy"]);
  });
});

describe("the count on Show N pull requests", () => {
  const rows = [row({ isDraft: true }), row(), row({ state: "MERGED" })];
  test("counts the loaded rows the filters keep", () => {
    expect(shownCount(rows, f({ draft: "ready" }), "open", false)).toBe(1);
  });
  test("is null for a state the loaded rows were not asked for", () => {
    expect(shownCount(rows, f({ state: "all" }), "open", false)).toBeNull();
    // Merged and Closed are one server question, so the loaded rows answer both.
    expect(shownCount(rows, f({ state: "merged" }), "closed", false)).toBe(1);
  });
  test("a search defaults to every state", () => {
    expect(effectiveState(NO_FILTERS, true)).toBe("all");
    expect(effectiveState(NO_FILTERS, false)).toBe("open");
    expect(effectiveState(f({ state: "closed" }), true)).toBe("closed");
  });
});

describe("search", () => {
  test("a search asks the whole repository: q=, every tab, and the page cursor", () => {
    expect(listPath({ root: "/w/orbit", tab: "review", state: "all", text: "  retry  ", after: "abc=" }))
      .toBe("/prs/list?root=%2Fw%2Forbit&filter=all&state=all&q=retry&after=abc%3D");
  });
  test("no words is the tab's own list, with no q", () => {
    expect(listPath({ root: "/w/orbit", tab: "review", state: "open", text: "   " }))
      .toBe("/prs/list?root=%2Fw%2Forbit&filter=review&state=open");
  });
  test("a chosen Merged asks the server for closed, as the list always did", () => {
    expect(listPath({ root: "r", tab: "mine", state: "merged", text: "x" })).toContain("state=closed");
  });
  test("#101 is sent as its number", () => {
    expect(searchText("#101 retry")).toBe("101 retry");
  });

  test("loaded rows matching by author or number join the server's, once each", () => {
    const p = (number: number, title: string, author = "cy") =>
      ({ number, title, author, headRefName: `fix/${number}`, assignees: [], reviewers: [] });
    const found = [p(87, "Backoff retry")];
    const browsed = [p(87, "Backoff retry"), p(101, "Sync", "retry-bot"), p(102, "Other")];
    expect(withLocalMatches(found, browsed, "retry").map((x) => x.number)).toEqual([87, 101]);
  });

  test("highlight marks every searched word, any case, merging overlaps", () => {
    expect(highlight("ORBIT-1042 Add Retry to sync", "retry")).toEqual([
      { text: "ORBIT-1042 Add ", hit: false }, { text: "Retry", hit: true }, { text: " to sync", hit: false },
    ]);
    expect(highlight("retry retry", "retry re")).toEqual([{ text: "retry", hit: true }, { text: " ", hit: false }, { text: "retry", hit: true }]);
    expect(highlight("nothing here", "zzz")).toEqual([{ text: "nothing here", hit: false }]);
    expect(highlight("plain", "  ")).toEqual([{ text: "plain", hit: false }]);
  });
});
