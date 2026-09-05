/*
 * The inbox's shelves, filters and search.
 *
 * All of it is composition — "unread review requests in the work repo" is one
 * question people ask on a Monday — and composition is where a filter list goes
 * quietly wrong: a count that says how many exist rather than how many pressing
 * it would leave, a facet that hides rows it does not understand, a shelf that
 * shows a thread in two places at once.
 *
 * Saved and Done are OURS rather than GitHub's — their REST API has no verb for
 * either (measured) — so the shelf rules are pinned here too.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { InboxItem } from "../../shared/types.ts";
import { byDay, facetCounts, facetOrder, filterInbox, inFacet, reasonLabel, searchInbox } from "../src/lib/ghInbox.ts";
import { __resetMarks, isDone, isSaved, onShelf, setDone, setSaved } from "../src/lib/inboxMarks.ts";

// No DOM under bun, and the shelves are two keys in localStorage. A Map is
// enough to test what they do with what they find there.
const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage;

const note = (over: Partial<InboxItem>): InboxItem => ({
  id: "1", unread: true, reason: "subscribed", type: "PullRequest",
  repo: "acme/orbit", title: "A title", at: Date.parse("2026-08-19T10:00:00Z"), number: 10,
  ...over,
});

const items = [
  note({ id: "1", reason: "review_requested", number: 11, title: "Stop routing calls that already ended" }),
  note({ id: "2", reason: "mention", number: 12, unread: false, title: "Billing cycle filter shows the wrong dates" }),
  note({ id: "3", reason: "author", number: 13, repo: "acme/tools", title: "Pin a command you type" }),
  note({ id: "4", reason: "team_mention", number: 14, unread: false }),
  note({ id: "5", reason: "subscribed", number: 15, type: "Issue" }),
];

describe("filters compose", () => {
  test("unread, reason and repository, together", () => {
    expect(filterInbox(items, {}).length).toBe(5);
    expect(filterInbox(items, { unread: true }).map((n) => n.id)).toEqual(["1", "3", "5"]);
    expect(filterInbox(items, { repo: "acme/tools" }).map((n) => n.id)).toEqual(["3"]);
    expect(filterInbox(items, { unread: true, repo: "acme/orbit" }).map((n) => n.id)).toEqual(["1", "5"]);
  });

  /* A count on a chip has to answer "what happens if I press this", which means
     every OTHER filter still applies while it is worked out. */
  test("a facet's counts are taken with the other facets still on", () => {
    const counts = facetCounts(items, { unread: true }, "repo");
    expect(counts.get("acme/orbit")).toBe(2);
    expect(counts.get("acme/tools")).toBe(1);
  });

  test("busiest first, and a stable tie-break", () => {
    const order = facetOrder(new Map([["b", 2], ["a", 2], ["c", 5]]));
    expect(order.map((x) => x.value)).toEqual(["c", "a", "b"]);
  });
});

describe("GitHub's named filters", () => {
  test("each one is a set of reasons, and Participating is several", () => {
    expect(inFacet(items[0]!, "review")).toBe(true);
    expect(inFacet(items[1]!, "mentioned")).toBe(true);
    expect(inFacet(items[3]!, "team")).toBe(true);
    expect(inFacet(items[2]!, "participating")).toBe(true);
    // Watching a repository is not participating in a thread.
    expect(inFacet(items[4]!, "participating")).toBe(false);
  });

  /* The safe direction: a facet id nobody knows must not empty somebody's
     inbox. */
  test("an id we do not know filters nothing", () => {
    expect(inFacet(items[0]!, "whatever-github-adds-next")).toBe(true);
  });

  test("the reason is put into words, and an unknown one still reads", () => {
    expect(reasonLabel("review_requested")).toBe("asked for your review");
    expect(reasonLabel("mention")).toBe("mentioned you");
    expect(reasonLabel("some_new_reason")).toBe("some new reason");
  });
});

describe("the search box", () => {
  test("title, repository and reason", () => {
    expect(searchInbox(items, "billing").map((n) => n.id)).toEqual(["2"]);
    expect(searchInbox(items, "acme/tools").map((n) => n.id)).toEqual(["3"]);
  });

  /* A bare number is a number, not a substring: `#13` must not answer with
     every title that has thirteen in it. */
  test("a number finds that number", () => {
    expect(searchInbox(items, "#13").map((n) => n.id)).toEqual(["3"]);
    expect(searchInbox(items, "13").map((n) => n.id)).toEqual(["3"]);
  });

  test("an empty box is not a filter", () => {
    expect(searchInbox(items, "   ").length).toBe(5);
  });
});

describe("the shelves, which are ours", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetMarks();
  });

  test("saving puts it on the saved shelf and leaves it in the inbox", () => {
    setSaved("2", true);
    expect(isSaved("2")).toBe(true);
    expect(onShelf(items, "saved").map((n) => n.id)).toEqual(["2"]);
    // GitHub's own does the same: saved is a shelf, not a move.
    expect(onShelf(items, "inbox").map((n) => n.id)).toContain("2");
  });

  test("finishing takes it out of the inbox — and off the saved shelf", () => {
    setSaved("3", true);
    setDone("3", true);
    expect(isDone("3")).toBe(true);
    expect(isSaved("3")).toBe(false);
    expect(onShelf(items, "inbox").map((n) => n.id)).not.toContain("3");
    expect(onShelf(items, "done").map((n) => n.id)).toEqual(["3"]);
  });

  test("undone puts it back", () => {
    setDone("1", true);
    setDone("1", false);
    expect(onShelf(items, "inbox").map((n) => n.id)).toContain("1");
  });

  test("the shelves survive a reload", () => {
    setSaved("4", true);
    __resetMarks();
    expect(isSaved("4")).toBe(true);
  });
});

describe("grouped by day", () => {
  test("today, yesterday, then the date", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const rows = [
      note({ id: "a", at: Date.parse("2026-08-19T09:00:00Z") }),
      note({ id: "b", at: Date.parse("2026-08-18T09:00:00Z") }),
      note({ id: "c", at: Date.parse("2026-08-11T09:00:00Z") }),
    ];
    const groups = byDay(rows, now);
    expect(groups.map((g) => g.label).slice(0, 2)).toEqual(["Today", "Yesterday"]);
    expect(groups).toHaveLength(3);
    expect(groups[2]!.items.map((n) => n.id)).toEqual(["c"]);
  });

  test("rows of the same day stay in one group", () => {
    const now = Date.parse("2026-08-19T12:00:00Z");
    const rows = [note({ id: "a", at: now - 3600_000 }), note({ id: "b", at: now - 7200_000 })];
    expect(byDay(rows, now)).toHaveLength(1);
  });
});
