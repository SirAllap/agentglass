/*
 * The redrawn Insights window: its decisions are pure, so they are pressed here.
 */
import { describe, expect, it } from "bun:test";
import { ago, changelogState, changesText, chartGeometry, copyView, fewDays, FIRST_COMMIT, fromRows, fromShown, initials, nothingNew, renameNote, sentence, splitPath, splits, tiles, toRows, unlistedText, windowDays } from "../src/lib/insightsModel.ts";
import type { Changelog, GitRangeCounts, RepoStats } from "../../shared/types.ts";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const day = (date: string, commits: number, added = 10, deleted = 2) => ({ date, commits, added, deleted });
const stats = (churn: ReturnType<typeof day>[], o: Partial<RepoStats> = {}): RepoStats => ({ days: 30, commitsPerDay: 0, contributors: [{ name: "Ada Orbit", email: "a@orbit.test", commits: 3, added: 1, deleted: 0 }], filesTouched: 4, linesChanged: 12, topContributors: [], hotspots: [{ path: "src/api/ledger.ts", commits: 2, added: 9, deleted: 3 }], churn, ...o });
const cl = (o: Partial<Changelog> = {}): Changelog => ({ from: "v1.1.0", to: "HEAD", sections: [], ...o });
const counts: GitRangeCounts = { tags: [{ name: "v1.1.0", count: 0, at: NOW - 2 * 86_400_000 }, { name: "v1.0.0", count: 12, at: NOW - 35 * 86_400_000 }, { name: "v0.9.2", count: 31, at: null }], root: 73 };

describe("sentence", () => {
  it("counts the days with commits, and names the day when there is only one", () => {
    expect(sentence(stats([day("2026-10-20", 2), day("2026-10-22", 1)])).when).toBe("on 2 of the days");
    const one = sentence(stats([day("2026-10-24", 9)], { days: 7 }));
    expect(one.when).toBe("all on one day (Oct 24)");
    expect(one.commits).toBe("9 commits");
  });
  it("is singular for one of each and names the busiest file", () => {
    const s = sentence(stats([day("2026-10-24", 1)], { contributors: [{ name: "A", email: "a", commits: 1, added: 0, deleted: 0 }] }));
    expect([s.people, s.commits, s.topFile]).toEqual(["1 person", "1 commit", "src/api/ledger.ts"]);
  });
  it("fewDays: a trend needs commits on two different days", () => {
    expect(fewDays(stats([day("2026-10-24", 3)]))).toBe(true);
    expect(fewDays(stats([]))).toBe(true);
    expect(fewDays(stats([day("2026-10-24", 1), day("2026-10-25", 1)]))).toBe(false);
  });
});

describe("tiles", () => {
  it("shows the pace and the added/removed split the days add up to", () => {
    const t = tiles(stats([day("2026-10-24", 15, 100, 40), day("2026-10-25", 15, 20, 5)]));
    expect(t[0]).toEqual({ k: "Commits", v: "30", sub: "1.0 a day" });
    expect(t[3].sub).toBe("+120 −45");
  });
});

describe("windowDays and chartGeometry", () => {
  it("fills the days that had no commits, ending today", () => {
    const w = windowDays([day("2026-10-25", 2)], 7, NOW);
    expect(w).toHaveLength(7);
    expect(w[6].date).toBe("2026-10-27");
    expect(w[4]).toMatchObject({ date: "2026-10-25", commits: 2 });
    expect(w[0].commits).toBe(0);
  });
  it("draws added up and removed down on one scale, and nothing for a quiet day", () => {
    const c = chartGeometry([{ date: "2026-10-25", commits: 1, added: 100, deleted: 50 }, { date: "2026-10-26", commits: 0, added: 0, deleted: 0 }, { date: "2026-10-27", commits: 1, added: 0, deleted: 100 }]);
    expect(c.bars[0].up).toBeGreaterThan(c.bars[0].down);
    expect(c.bars[1]).toMatchObject({ up: 0, down: 0 });
    expect(c.bars[2].up).toBe(0);
    expect(c.bars[2].down).toBeGreaterThan(0);
  });
  it("labels the axis at the start, every week, and the last day when it is far enough", () => {
    const d = windowDays([], 30, NOW);
    expect(chartGeometry(d).labels.map((l) => l.text)).toEqual(["Sep 28", "Oct 5", "Oct 12", "Oct 19", "Oct 26"]);
    expect(chartGeometry(windowDays([], 7, NOW)).labels).toHaveLength(3);
  });
});

describe("bars, paths and names", () => {
  it("scales every row against the largest and keeps an empty list empty", () => {
    expect(splits([{ added: 80, deleted: 20 }, { added: 20, deleted: 5 }])).toEqual([{ addPct: 80, delPct: 20 }, { addPct: 20, delPct: 5 }]);
    expect(splits([])).toEqual([]);
    expect(splits([{ added: 0, deleted: 0 }])).toEqual([{ addPct: 0, delPct: 0 }]);
  });
  it("splits a path at its last slash and notes a rename once", () => {
    expect(splitPath("src/lib/y.ts")).toEqual({ dir: "src/lib/", file: "y.ts" });
    expect(splitPath("CHANGELOG.md")).toEqual({ dir: "", file: "CHANGELOG.md" });
    expect(renameNote({ path: "a/y.ts", commits: 1, added: 0, deleted: 0, renamedFrom: "b/y.ts" })).toBe("renamed from b/y.ts");
    expect(renameNote({ path: "a/y.ts", commits: 1, added: 0, deleted: 0 })).toBeNull();
  });
  it("initials come from the name, then the email", () => {
    expect(initials({ name: "Dev Quasar", email: "" })).toBe("DQ");
    expect(initials({ name: "", email: "ben@orbit.test" })).toBe("B");
  });
});

describe("range picker rows", () => {
  it("lists tags newest first with their counts, and the first commit under Other", () => {
    const r = fromRows(counts, "", true, NOW);
    expect(r.tags.map((t) => [t.label, t.age, t.count])).toEqual([["v1.1.0", "2 d", 0], ["v1.0.0", "5 w", 12], ["v0.9.2", null, 31]]);
    expect(r.other).toEqual([{ value: FIRST_COMMIT, label: "The first commit", age: null, count: 73, kind: "first" }]);
  });
  it("drops the counts when the range does not end at HEAD", () => {
    const r = fromRows(counts, "", false, NOW);
    expect([...r.tags, ...r.other].every((x) => x.count === null)).toBe(true);
  });
  it("filters by what is typed and offers a typed ref that is no tag", () => {
    expect(fromRows(counts, "v0.9", true).tags.map((t) => t.label)).toEqual(["v0.9.2"]);
    expect(fromRows(counts, "abc1234", true).other.map((o) => o.value)).toEqual(["abc1234"]);
    expect(fromRows(counts, "v1.0.0", true).other).toEqual([]);
  });
  it("To starts at HEAD, then branches, then tags", () => {
    const r = toRows(["main", "dev"], ["v1"], "");
    expect([r.head[0].value, r.branches.map((b) => b.value), r.tags.map((t) => t.value)]).toEqual(["HEAD", ["main", "dev"], ["v1"]]);
    expect(toRows(["main"], [], "ma").branches).toHaveLength(1);
  });
  it("ago picks one unit", () => {
    expect([ago(NOW - 86_400_000, NOW), ago(NOW - 35 * 86_400_000, NOW), ago(NOW - 90 * 86_400_000, NOW), ago(NOW - 800 * 86_400_000, NOW), ago(null)]).toEqual(["1 d", "5 w", "3 mo", "2 y", null]);
  });
  it("fromShown names the picked ref, else the server's default, else the start of history", () => {
    expect(fromShown("v0.9.2", cl())).toBe("v0.9.2");
    expect(fromShown("", cl({ from: "v1.1.0" }))).toBe("v1.1.0");
    expect(fromShown("", cl({ from: "" }))).toBe("The first commit");
    expect(fromShown(FIRST_COMMIT, cl())).toBe("The first commit");
  });
});

describe("changelog states", () => {
  it("nothing new: HEAD is the tag, and the next older tag with commits is one press away", () => {
    expect(nothingNew(cl({ sinceCount: 0 }), counts)).toEqual({ tag: "v1.1.0", older: { value: "v1.0.0", label: "v1.0.0", count: 12 } });
    expect(changelogState(cl({ sinceCount: 0 }), counts)).toBe("nothing-new");
  });
  it("skips older tags that sit on the same commit", () => {
    const same: GitRangeCounts = { tags: [{ name: "v2", count: 0, at: null }, { name: "v2-rc", count: 0, at: null }, { name: "v1", count: 4, at: null }], root: 9 };
    expect(nothingNew(cl({ from: "v2", sinceCount: 0 }), same)?.older?.value).toBe("v1");
  });
  it("falls back to the first commit when no older tag exists, and to nothing without counts", () => {
    const one: GitRangeCounts = { tags: [{ name: "v1.1.0", count: 0, at: null }], root: 5 };
    expect(nothingNew(cl({ sinceCount: 0 }), one)?.older).toEqual({ value: FIRST_COMMIT, label: "the first commit", count: 5 });
    expect(nothingNew(cl({ sinceCount: 0 }), null)?.older).toBeNull();
  });
  it("is not 'nothing new' for a picked end, an error, an empty repo, or commits that are only merges", () => {
    expect(nothingNew(cl({ sinceCount: 0, to: "v1.0.0" }), counts)).toBeNull();
    expect(nothingNew(cl({ sinceCount: 0, error: "bad" }), counts)).toBeNull();
    expect(nothingNew(cl({ sinceCount: 0, empty: true, from: "" }), counts)).toBeNull();
    expect(changelogState(cl({ sinceCount: 3, unlisted: 3 }), counts)).toBe("no-commits");
  });
  it("one state per answer", () => {
    expect(changelogState(null, counts)).toBe("loading");
    expect(changelogState(cl({ error: "x" }), counts)).toBe("error");
    expect(changelogState(cl({ empty: true, from: "" }), counts)).toBe("empty-repo");
    expect(changelogState(cl({ sinceCount: 1, sections: [{ title: "Fixes", entries: [] }] }), counts)).toBe("list");
  });
  it("counts changes by the range, and says how many commits the sections leave out", () => {
    expect(changesText(cl({ sinceCount: 12 }))).toBe("12 changes");
    expect(changesText(cl({ sinceCount: 1 }))).toBe("1 change");
    expect(changesText(cl({ error: "x" }))).toBe("");
    expect(unlistedText(cl({ unlisted: 9 }))).toBe("9 other commits are not listed.");
    expect(unlistedText(cl({ unlisted: 1 }))).toBe("1 other commit is not listed.");
    expect(unlistedText(cl({ unlisted: 0 }))).toBeNull();
    expect(unlistedText(cl())).toBeNull();
  });
});

describe("copyView", () => {
  it("copied returns to rest after 2 s and tells a screen reader; failed stays, explains, and frees the list", () => {
    expect(copyView("idle")).toMatchObject({ label: "Copy as Markdown", live: "", resetsAfter: null, selectable: false });
    expect(copyView("copied")).toMatchObject({ label: "Copied", live: "Changelog copied as Markdown", resetsAfter: 2000 });
    const f = copyView("failed");
    expect(f.resetsAfter).toBeNull();
    expect(f.selectable).toBe(true);
    expect(f.tip).toContain("Select the list and copy it by hand");
  });
});
