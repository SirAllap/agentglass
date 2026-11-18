/*
 * The PR board's five lanes, as decisions.
 *
 * The classifier is the desk's (`shared/prLanes.ts`) and is pinned down by its
 * own suite; what is asserted here is the phone's half — the two list reads
 * folded into one stake, the five lanes in the classifier's order, the empty
 * lane's sentence, the cap, the two rules whose drawer is always on screen, and
 * the saved views the computer holds, narrowed by the shared evaluator.
 *
 * Fixtures are hand-built `PrSummary` shapes with invented names, never the
 * classifier's own output, so a change to the fixture cannot agree with a
 * change to the rule by accident.
 */
import { describe, expect, test } from "bun:test";
import type { PrCheck, PrSummary } from "../../shared/types.ts";
import { LANES } from "../../shared/prLanes.ts";
import { emptyLanes, type LaneFilter, type PrView } from "../../shared/prFilter.ts";
import { evalLanes } from "../../shared/prFilterEval.ts";
import { readPrFieldOrNull } from "../../shared/prFilterFields.ts";
import {
  EMPTY_SENTENCE, HIDE_BY_RULES, boardRows, emptyLaneWords, foldLists, hiddenByRules, inView, isBot,
  laneBoard, viewChips, viewCount, viewHiddenCount, type BoardData, type LaneRules,
} from "../src/model/prBoard.ts";

const check = (name: string): PrCheck => ({ name, workflow: "CI", state: "failure", done: true });

type Overrides = Partial<PrSummary> & { fail?: number; pend?: number; ok?: number; failing?: string[] };

const pr = (o: Overrides = {}): PrSummary => {
  const { fail = 0, pend = 0, ok = 3, failing = [], ...rest } = o;
  return {
    number: 1, title: "Phone: the lane drawer", author: "ada", state: "OPEN", isDraft: false,
    headRefName: "feat/ORBIT-1042", baseRefName: "main", url: "", updatedAt: "2026-11-04T00:00:00Z",
    reviewDecision: null, additions: 10, deletions: 2, changedFiles: 2, labels: [], assignees: [],
    milestone: null, mergeable: "MERGEABLE", checksLoaded: true,
    checks: {
      total: ok + fail + pend, success: ok, failure: fail, skipped: 0, pending: pend,
      allDone: pend === 0, verdict: pend ? null : fail ? "red" : "green",
      failing: failing.map(check),
    },
    ...rest,
  } as PrSummary;
};

const green = (n: number): PrSummary => pr({
  number: n, reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["rui"] },
});
const data = (mine: PrSummary[] = [], review: PrSummary[] = []): BoardData => ({ mine, review });
const open = (d: BoardData, rules?: LaneRules) => laneBoard(d, foldLists(d.mine, d.review), rules);
const laneOf = (d: BoardData, id: string) => open(d).find((l) => l.id === id)!;

describe("the two list reads, folded", () => {
  test("a pull request both lists answered appears once, and keeps both facts", () => {
    const both = pr({ number: 7 });
    const folded = foldLists([both], [both]);
    expect(folded).toHaveLength(1);
    expect(folded[0]!.number).toBe(7);
  });

  test("each list's own rows survive in it, in the order the lists answered", () => {
    expect(foldLists([pr({ number: 2 }), pr({ number: 4 })], [pr({ number: 9 })]).map((p) => p.number))
      .toEqual([2, 4, 9]);
  });

  test("the same number in two repositories is two pull requests", () => {
    const a = pr({ number: 12 });
    const b = pr({ number: 12 });
    expect(foldLists([a, b], [], (p) => (p === a ? "/one" : "/two"))).toHaveLength(2);
  });
});

describe("whose pull requests the board answers", () => {
  const mine = pr({ number: 81, title: "Phone: the lane drawer", author: "ada" });
  const review = pr({ number: 82, title: "Desk: the strip follows", author: "rui" });
  const stranger = pr({ number: 83, title: "Desk: a stranger's bump", author: "kai" });

  test("off, the board is your two queues and a stranger's row is not on it", () => {
    const rows = boardRows({ mine: [mine], review: [review], all: [mine, review, stranger] }, false);
    expect(rows.map((p) => p.number)).toEqual([81, 82]);
  });

  test("on, the repository's other rows are on it too", () => {
    const rows = boardRows({ mine: [mine], review: [], all: [mine, stranger] }, true);
    expect(rows.map((p) => p.number)).toEqual([81, 83]);
    expect(rows.map((p) => p.author)).toEqual(["ada", "kai"]);
  });

  test("a pull request that is both mine and a review asked of me is one card", () => {
    const askedOfMe = pr({ number: 91, title: "Desk: the strip follows", author: "rui" });
    const alsoMine = pr({ number: 91, title: "Phone: the lane drawer", author: "ada" });
    const rows = boardRows({ mine: [alsoMine], review: [askedOfMe] }, false);
    expect(rows).toHaveLength(1);
    // The `mine` copy is the one kept, so the card keeps its author's stake.
    expect(rows[0]!.title).toBe("Phone: the lane drawer");
  });

  test("on, a row that is mine and in the repository's list is still one card", () => {
    const rows = boardRows({ mine: [mine], review: [review], all: [review, mine, stranger] }, true);
    expect(rows.map((p) => p.number)).toEqual([81, 82, 83]);
  });

  test("off, an `all` list that was not asked for is not read", () => {
    expect(boardRows({ mine: [mine], review: [] }, false).map((p) => p.number)).toEqual([81]);
  });
});

describe("five lanes", () => {
  test("in the classifier's order, every one of them, always", () => {
    const lanes = open(data());
    expect(lanes.map((l) => l.id)).toEqual(["review", "land", "blocked", "others", "flight"]);
    expect(lanes.map((l) => l.id)).toEqual(LANES.map((l) => l.id));
    expect(lanes.map((l) => l.label)).toEqual(LANES.map((l) => l.label));
  });

  test("a review asked of you beats green: it is filed under review", () => {
    const asked = green(11);
    const lanes = open(data([], [asked]));
    expect(lanes.find((l) => l.id === "review")!.cards.map((c) => c.pr.number)).toEqual([11]);
    expect(lanes.find((l) => l.id === "land")!.cards).toHaveLength(0);
  });

  test("yours and approved and green is ready to land", () => {
    expect(laneOf(data([green(12)]), "land").cards[0]!.pr.number).toBe(12);
  });

  test("yours, open and nobody asked is in flight", () => {
    expect(laneOf(data([pr({ number: 13 })]), "flight").cards).toHaveLength(1);
  });

  test("yours with a named red check is blocked", () => {
    expect(laneOf(data([pr({ number: 14, fail: 1, failing: ["e2e"] })]), "blocked").cards).toHaveLength(1);
  });

  test("the stake comes from the two unfiltered lists, not from the rows that survived a filter", () => {
    // The filter left the `mine` copy out; the row is still recognised as yours.
    const mineOnly = pr({ number: 15, reviewDecision: "APPROVED" });
    const d = data([mineOnly], []);
    // The screen bypasses `foldLists` when it filters; the same row filed from
    // `visible` keeps the stake the unfiltered lists gave it.
    const lanes = laneBoard(d, [mineOnly]);
    expect(lanes.find((l) => l.id === "land")!.cards).toHaveLength(1);
  });
});

describe("an empty lane says so, quietly", () => {
  test("each lane has its own sentence, and none sends the reader looking", () => {
    const sentences = LANES.map((l) => EMPTY_SENTENCE[l.id]);
    expect(new Set(sentences).size).toBe(5);
    for (const s of sentences) expect(s.length).toBeGreaterThan(10);
  });

  test("an empty lane is still on the board, with its count at zero", () => {
    const lanes = open(data([green(21)]));
    const review = lanes.find((l) => l.id === "review")!;
    expect(review.count).toBe(0);
    expect(review.cards).toEqual([]);
  });

  test("a narrowed board blames the filters, not the repository", () => {
    expect(emptyLaneWords("review", true)).toContain("filters");
    expect(emptyLaneWords("review", false)).toBe(EMPTY_SENTENCE.review);
  });
});

describe("the cap", () => {
  test("twenty cards are drawn and the rest are counted, not hidden", () => {
    const many = Array.from({ length: 24 }, (_, i) => green(100 + i));
    const land = laneOf(data(many), "land");
    expect(land.count).toBe(24);
    expect(land.cards).toHaveLength(20);
    expect(land.more).toBe(4);
  });

  test("under the cap nothing is left over", () => {
    const land = laneOf(data([green(1), green(2)]), "land");
    expect(land.cards).toHaveLength(2);
    expect(land.more).toBe(0);
  });
});

describe("the rules drawer", () => {
  test("drafts and bot bumps are behind the rules, and counted in their lane", () => {
    const draft = pr({ number: 31, isDraft: true, reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["rui"] } });
    const bot = pr({ number: 32, author: "dependabot[bot]", reviewDecision: "APPROVED", humanReview: { kind: "approved", who: ["rui"] } });
    const d = data([draft, bot, green(33)]);
    const landed = laneOf(d, "land");
    expect(landed.count).toBe(1);
    expect(landed.cards.map((c) => c.pr.number)).toEqual([33]);
    expect(landed.hidden.map((c) => c.pr.number)).toEqual([32]);
    // A draft files under your own lane whatever anybody decided about it.
    expect(laneOf(d, "flight").hidden.map((c) => c.pr.number)).toEqual([31]);
  });

  test("turning a rule off puts its cards back in the lane", () => {
    const draft = pr({ number: 41, isDraft: true });
    const off: LaneRules = { drafts: false, bots: true };
    const lane = laneOf(data([draft]), "flight");
    expect(lane.hidden).toHaveLength(1);
    expect(open(data([draft]), off).find((l) => l.id === "flight")!.cards).toHaveLength(1);
  });

  test("a bot is known by its login, which is the only fact the list carries", () => {
    expect(isBot({ author: "dependabot[bot]" })).toBe(true);
    expect(isBot({ author: "bot" })).toBe(true);
    expect(isBot({ author: "Ada" })).toBe(false);
    expect(hiddenByRules(pr({ isDraft: true }), HIDE_BY_RULES)).toBe(true);
    expect(hiddenByRules(pr({ author: "dependabot[bot]" }), HIDE_BY_RULES)).toBe(true);
  });
});

describe("the press the lane implies", () => {
  test("green is Merge, stable red is Re-run failed, review is Review", () => {
    expect(laneOf(data([green(51)]), "land").cards[0]!.action).toBe("merge");
    expect(laneOf(data([pr({ number: 52, fail: 1, failing: ["unit"] })]), "blocked").cards[0]!.action).toBe("rerun");
    expect(open(data([], [pr({ number: 53 })])).find((l) => l.id === "review")!.cards[0]!.action).toBe("open");
  });
});

describe("saved views are the computer's", () => {
  const NOW = Date.parse("2026-11-05T00:00:00Z");
  const view = (id: string, filter: LaneFilter): PrView => ({ id, name: id, filter, order: 0 });
  const read = (p: PrSummary, key: string): string[] | null => readPrFieldOrNull(p, key, NOW);
  const rule = (id: string, field: string, op: "is" | "unset", values: string[] = []) =>
    ({ id, field, op, values }) as const;

  test("a view ANDs its show rules and subtracts its hide rule", () => {
    const f = emptyLanes();
    f.show.children.push(rule("s1", "author", "is", ["ada"]));
    f.show.children.push(rule("s2", "checks", "is", ["green"]));
    f.hide.children.push(rule("h1", "label", "is", ["needs work"]));
    const rows = [
      pr({ number: 71, author: "ada" }),
      pr({ number: 72, author: "ada", labels: [{ name: "needs work", color: "" }] }),
      pr({ number: 73, author: "rui" }),
      pr({ number: 74, author: "ada", fail: 1 }),
    ];
    // The same rows the desk's evaluator keeps — and the literal answer, so a
    // change to the fixture cannot agree with a change to the rule by accident.
    expect(inView(rows, view("v1", f), { now: NOW }).map((p) => p.number)).toEqual([71]);
    expect(evalLanes(rows, f, read).kept.map((p) => p.number)).toEqual([71]);
  });

  test("a view naming a field this build does not know keeps everything", () => {
    const f = emptyLanes();
    f.show.children.push(rule("s1", "invented-later", "is", ["x"]));
    // `unset` on an unknown field would hide every row if the field read as empty.
    f.hide.children.push(rule("h1", "also-invented", "unset"));
    const rows = [pr({ number: 81 }), pr({ number: 82, isDraft: true })];
    expect(inView(rows, view("v2", f), { now: NOW }).map((p) => p.number)).toEqual([81, 82]);
  });

  test("each chip counts the rows opening it would draw", () => {
    const everything = emptyLanes();
    const conflicts = emptyLanes();
    conflicts.show.children.push(rule("s1", "conflict", "is", ["yes"]));
    const rows = [pr({ number: 91 }), pr({ number: 92, mergeable: "CONFLICTING" })];
    expect(viewChips(rows, [view("it-all", everything), view("conflicts", conflicts)], { now: NOW }).map((c) => [c.view.name, c.count]))
      .toEqual([["it-all", 2], ["conflicts", 1]]);
    expect(viewCount(rows, view("conflicts", conflicts), { now: NOW })).toBe(1);
    expect(inView([pr({ number: 93 })], view("conflicts", conflicts), { now: NOW })).toEqual([]);
  });

  test("a second pass that has not landed is kept, not read as no checks", () => {
    const f = emptyLanes();
    f.show.children.push(rule("s1", "checks", "is", ["green"]));
    const rows = [pr({ number: 94 }), pr({ number: 95, checksLoaded: false })];
    expect(inView(rows, view("green", f), { now: NOW }).map((p) => p.number)).toEqual([94, 95]);
  });

  test("the desk's exemption is the phone's: an unread row is never dropped", () => {
    const f = emptyLanes();
    f.show.children.push(rule("s1", "checks", "is", ["green"]));
    const rows = [pr({ number: 96, fail: 1, url: "https://github.com/acme/orbit/pull/96" })];
    const exempt = (p: PrSummary): boolean => p.number === 96;
    expect(inView(rows, view("green", f), { now: NOW }).map((p) => p.number)).toEqual([]);
    expect(inView(rows, view("green", f), { now: NOW, exempt }).map((p) => p.number)).toEqual([96]);
    expect(viewCount(rows, view("green", f), { now: NOW, exempt })).toBe(1);
  });

  test("a rule naming a prototype key narrows nothing instead of throwing", () => {
    for (const field of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const f = emptyLanes();
      f.show.children.push(rule("s1", field, "is", ["x"]));
      expect(inView([pr({ number: 97 })], view(field, f), { now: NOW })).toHaveLength(1);
    }
  });

  test("what a view hides is counted, so the screen can say it", () => {
    const f = emptyLanes();
    f.show.children.push(rule("s1", "author", "is", ["ada"]));
    const rows = [pr({ number: 98 }), pr({ number: 99, author: "rui" }), pr({ number: 100, author: "kai" })];
    expect(viewCount(rows, view("ada", f), { now: NOW })).toBe(1);
    expect(viewHiddenCount(rows, view("ada", f), { now: NOW })).toBe(2);
  });
});

describe("the screen draws the map it was given", () => {
  test("the board is one component, filed by this model, and never re-sorted", async () => {
    const screen = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    const model = await Bun.file(new URL("../src/model/prBoard.ts", import.meta.url)).text();
    const column = await Bun.file(new URL("../src/board/LaneColumn.tsx", import.meta.url)).text();
    expect(screen).toContain("<LaneBoard");
    expect(screen).toContain("laneBoard(boardData");
    expect(column).toContain("RefreshControl");
    expect(column).toContain("hidden by your rules");
    expect(column).toContain("Peek");
    expect(model).not.toContain(".sort(");
  });

  test("the screen opens on your two queues and asks the repository only while the switch is on", async () => {
    const screen = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    expect(screen).toContain("boardRows(boardData");
    expect(screen).toContain("const [everyone, setEveryone] = useState(false);");
    // The visible switch, not only the one in the filter sheet.
    expect(screen).toContain('accessibilityLabel="Show everyone’s pull requests"');
    // The `all` read sits behind the switch, so it costs nothing while it is off.
    expect(screen).toMatch(/everyone\s*?\?[\s\S]{0,200}?tab: "all"/);
  });

  test("the screen reads the desk's views again on focus, without a poll", async () => {
    const screen = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    expect(screen).toContain('AppState.addEventListener("change"');
    expect(screen).toContain("void loadViews(host, repoSlug, true)");
    // The sheet opening is the other event that reads the file again.
    expect(screen).toMatch(/if \(sheet && host && repoSlug\) void loadViews\(host, repoSlug, true\)/);
  });

  test("what the view hid is counted over the rows the board draws, not the whole board", async () => {
    const screen = await Bun.file(new URL("../app/(tabs)/prs.tsx", import.meta.url)).text();
    // One narrow list, made by this phone's own facets, read by both.
    expect(screen).toContain("const boardNarrowed = useMemo(");
    expect(screen).toContain("byState(boardAll, view).filter((p) => matchesFilters(p, filters))");
    expect(screen).toContain("inView(boardNarrowed, activeView");
    expect(screen).toContain("viewHiddenCount(boardNarrowed, activeView");
    // The old count over `boardAll` said rows were hidden that were never drawn.
    expect(screen).not.toContain("viewHiddenCount(boardAll");
  });
});
