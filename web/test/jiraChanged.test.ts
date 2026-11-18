import { describe, expect, test } from "bun:test";
import { NO_FILTERS, filterCards, lanesOf } from "../src/components/jira/list/model.ts";
import type { ListStatus, ProviderTask } from "../../shared/providers.ts";
import { capSnaps, changeOf, changedChip, changedMap, changedSay, chipWords, drawnIds, freshComments, sinceLooked, newSinceBoard, onlyCards, siteOf, snapOf, SNAP_CAP, type SeenCard } from "../src/lib/jiraChanged.ts";

// A board card shaped like a real read: the fields the board carries, on an invented site.
const card = (o: Partial<SeenCard> = {}): SeenCard => ({ id: "10042", status: "In progress", assignees: ["Ana Example"], comments: 2, updated: 2000, created: 100, mine: false, url: "https://acme.example.net/browse/ORBIT-1042", ...o });
const seen = snapOf(card({ updated: 1000 }), 1500);

describe("changeOf", () => {
  test("never looked at: no claim", () => expect(changeOf(card(), undefined)).toBeNull());
  test("not updated since: quiet", () => expect(changeOf(card({ updated: 1400 }), seen)).toBeNull());
  test("new comments", () => expect(changeOf(card({ comments: 4 }), seen)).toEqual({ kinds: ["comments"], reason: "2 new comments", count: 2 }));
  test("one comment is singular", () => expect(changeOf(card({ comments: 3 }), seen)?.reason).toBe("1 new comment"));
  test("a move without history names no one", () => expect(changeOf(card({ status: "Code review" }), seen)?.reason).toBe("moved to Code review"));
  test("a move with the history names who", () => {
    const more = { events: [{ at: 1800, kind: "status", status: "Code review", who: "Jonas Example" }] };
    expect(changeOf(card({ status: "Code review" }), seen, more)?.reason).toBe("moved to Code review by Jonas E.");
  });
  test("an old history row is not this move", () => {
    const more = { events: [{ at: 900, kind: "status", status: "In progress", who: "Jonas Example" }] };
    expect(changeOf(card({ status: "Code review" }), seen, more)?.reason).toBe("moved to Code review");
  });
  test("handed to you", () => expect(changeOf(card({ mine: true, assignees: ["Me Self"] }), seen)?.reason).toBe("assigned to you"));
  test("handed to another", () => expect(changeOf(card({ assignees: ["Jonas Example"] }), seen)?.reason).toBe("assigned to Jonas E."));
  test("unassigned", () => expect(changeOf(card({ assignees: [] }), seen)?.reason).toBe("unassigned"));
  test("a mention leads, then the comments", () => {
    const more = { me: "Me Self", comments: [{ at: 1900, who: "Ana Example", text: "ping @me self about the rollout" }] };
    expect(changeOf(card({ comments: 3 }), seen, more)).toMatchObject({ kinds: ["mention", "comments"], reason: "Ana E. mentioned you, 1 new comment" });
  });
  test("two reasons at most", () => expect(changeOf(card({ comments: 5, status: "Done", assignees: [] }), seen)?.reason).toBe("3 new comments, moved to Done"));
  test("updated with nothing we can name is an edit", () => expect(changeOf(card(), seen)).toEqual({ kinds: ["edited"], reason: "edited" }));
  test("comment count unknown on both sides: not a comment", () => expect(changeOf(card({ comments: undefined }), snapOf(card({ comments: undefined }), 1500))?.kinds).toEqual(["edited"]));
});

describe("board", () => {
  const key = (c: SeenCard) => `ORBIT-${c.id}`;
  test("a card with no snapshot made after the board was opened is new", () => {
    expect(newSinceBoard(card({ created: 1800 }), 1500)?.reason).toBe("new card");
    expect(newSinceBoard(card({ created: 100 }), 1500)).toBeNull();
    expect(newSinceBoard(card({ created: 1800 }), 0)).toBeNull();
  });
  test("changedMap flags only the cards that moved", () => {
    const cards = [card({ id: "1", comments: 5 }), card({ id: "2", updated: 1000 }), card({ id: "3", created: 1900 })];
    const snaps = { "ORBIT-1": seen, "ORBIT-2": snapOf(card({ id: "2" }), 1500) };
    const m = changedMap(cards, snaps, 1500, key);
    expect([...m.keys()]).toEqual(["1", "3"]);
  });
  test("a board never opened flags nothing", () => expect(changedMap([card({ id: "1" })], {}, 0, key).size).toBe(0));
  test("chip words", () => expect(changedChip(3)).toBe("3 changed since you looked"));
  test("onlyCards filters cards and lanes and recounts", () => {
    const m = { cards: [{ id: "a" }, { id: "b" }], lanes: [{ key: "x", cards: [{ id: "a" }] }, { key: "y", cards: [{ id: "b" }] }], counts: { shown: 2, total: 9 } };
    const out = onlyCards(m, (id) => id === "b");
    expect(out.cards).toEqual([{ id: "b" }]);
    expect(out.lanes.map((l) => l.cards.length)).toEqual([0, 1]);
    expect(out.counts).toEqual({ shown: 1, total: 9 });
  });
});

describe("keys and caps", () => {
  test("siteOf is the host", () => { expect(siteOf(card())).toBe("acme.example.net"); expect(siteOf({})).toBe(""); expect(siteOf({ url: "nope" })).toBe(""); });
  test("capSnaps keeps the newest", () => {
    const m = Object.fromEntries(Array.from({ length: SNAP_CAP + 5 }, (_, i) => [`K-${i}`, snapOf(card(), i)]));
    const out = capSnaps(m);
    expect(Object.keys(out).length).toBe(SNAP_CAP);
    expect(out["K-0"]).toBeUndefined();
  });
});

describe("changedSay", () => {
  test("off: the plain chip and nothing else", () => {
    expect(changedSay(false, 5, 3)).toEqual({ chip: "3 changed since you looked", count: null, note: null });
  });
  test("on, every changed card in view: the words change even though the board looks the same", () => {
    const s = changedSay(true, 2, 2);
    expect(s.chip).toBe("Showing 2 changed");
    expect(s.count).toBe("changed only");
    expect(s.note).toBeNull();
  });
  test("on, none in view: says why nothing shows", () => {
    expect(changedSay(true, 1, 0).note).toContain("hidden by your filters or display settings");
  });
  test("on, some in view: counts the rest as hidden", () => {
    expect(changedSay(true, 3, 1).note).toBe("2 more changed cards are hidden by your filters or display settings.");
  });
});

test("onlyCards filters nested swimlanes, which are the ones the board draws", () => {
  const c = (id: string) => ({ id });
  const model = { cards: [c("1"), c("2"), c("3")], counts: { shown: 3 }, lanes: [{ cards: [c("1"), c("2"), c("3")], sub: [{ cards: [c("1"), c("2")] }, { cards: [c("3")] }] }] };
  const out = onlyCards(model, (id) => id === "2");
  expect(out.lanes[0]!.sub!.flatMap((l) => l.cards.map((x) => x.id))).toEqual(["2"]);
  expect(out.lanes[0]!.cards.map((x) => x.id)).toEqual(["2"]);
});

/* A board shaped like the real one: a parent story with sub-tasks in a done column, a moved card, a new card, a card edited. */
describe("the changed count matches the cards the board draws", () => {
  const st = (status: string, i: number, type: ListStatus["type"] = "open"): ListStatus => ({ status, type, orderindex: i });
  const STATUSES = [st("To do", 0), st("In progress", 1), st("QA complete", 2, "done")];
  const t = (id: string, status: string, o: Partial<ProviderTask> = {}): ProviderTask =>
    ({ id, customId: `ORBIT-${id}`, title: `Card ${id}`, status, statusKind: status === "QA complete" ? "done" : "open", assignees: ["Ana Example"], tags: [], comments: 1, updated: 1000, created: 100, url: `https://acme.example.net/browse/ORBIT-${id}`, ...o } as ProviderTask);
  const before = [
    t("1", "QA complete", { issueType: "Story", subtasks: 2 }),
    t("2", "QA complete", { issueType: "Sub-task", parent: { key: "ORBIT-1", title: "Story" } as ProviderTask["parent"] }),
    t("3", "QA complete", { issueType: "Sub-task", parent: { key: "ORBIT-1", title: "Story" } as ProviderTask["parent"] }),
    t("4", "To do"), t("5", "In progress"),
  ];
  const snaps = Object.fromEntries(before.map((c) => [c.id, snapOf(c, 1500)]));
  // Later: a comment on the parent, a move, an edit, and a card that did not exist.
  const now = [
    { ...before[0]!, comments: 2, updated: 2000 },
    before[1]!, before[2]!,
    { ...before[3]!, status: "In progress", updated: 2000 },
    { ...before[4]!, updated: 2000 },
    t("6", "To do", { created: 1800, updated: 1800 }),
  ];
  const changed = changedMap(now, snaps, 1500, (c) => c.id);

  test("every one of the four is changed", () => expect([...changed.keys()].sort()).toEqual(["1", "4", "5", "6"]));

  test("with Show done off the parent sits in no lane: the chip counts what is drawn, not what is loaded", () => {
    const shown = filterCards(now, { ...NO_FILTERS, showDone: false });
    const drawn = drawnIds(lanesOf(shown, STATUSES));
    const inView = [...changed.keys()].filter((id) => drawn.has(id)).length;
    expect(inView).toBe(3);
    expect(changedSay(true, changed.size, inView).chip).toBe("Showing 3 changed");
    expect(changedSay(true, changed.size, inView).note).toBe("1 more changed card is hidden by your filters or display settings.");
    expect(changedSay(false, changed.size, inView).chip).toBe("3 changed since you looked");
  });

  test("with Show done on all four are drawn, the parent among them", () => {
    const drawn = drawnIds(lanesOf(filterCards(now, { ...NO_FILTERS, showDone: true }), STATUSES));
    expect([...changed.keys()].every((id) => drawn.has(id))).toBe(true);
  });

  test("drawnIds reads the innermost lanes", () => {
    expect([...drawnIds([{ cards: [{ id: "a" }, { id: "b" }], sub: [{ cards: [{ id: "b" }] }] }])]).toEqual(["b"]);
  });
});

describe("the card chip", () => {
  const more = { comments: [{ at: 1900, who: "Ana Example", text: "ok" }, { at: 1950, who: "Me Self", text: "mine", mine: true }] };
  test("one comment reads in words, more read as a count", () => {
    expect(chipWords({ kinds: ["comments"], reason: "1 new comment", count: 1 })).toBe("1 new comment");
    expect(chipWords({ kinds: ["comments"], reason: "2 new comments", count: 2 })).toBe("2 new");
    expect(chipWords({ kinds: ["moved"], reason: "moved to Done" })).toBe("moved to Done");
  });
  test("the tooltip says since when and from whom when the comments are loaded; my own never count", () => {
    const ch = changeOf(card({ comments: 4 }), seen, more)!;
    expect(ch.count).toBe(2);
    expect(ch.who).toEqual(["Ana E."]);
    expect(sinceLooked(ch)).toBe("2 new comments since you last looked, from Ana E.");
    expect(sinceLooked({ kinds: ["comments"], reason: "1 new comment", count: 1 })).toBe("1 new comment since you last looked");
  });
  test("freshComments: others', after the time, oldest first; never looked means none", () => {
    const cs = [{ id: "b", at: 30 }, { id: "a", at: 20 }, { id: "m", at: 40, mine: true }, { id: "o", at: 5 }];
    expect(freshComments(cs, 10).map((c) => c.id)).toEqual(["a", "b"]);
    expect(freshComments(cs, 0)).toEqual([]);
  });
});
