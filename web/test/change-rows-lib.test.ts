/*
 * The Diff view's data rules, without a DOM.
 *
 * Every case here is a bug the previous version shipped. They are gathered in
 * one suite because they share a cause — the view's data logic lived inside a
 * 900-line component, where it could only be tested by looking at it — and the
 * point of moving it out was to be able to write this file.
 */
import { describe, expect, it } from "bun:test";
import {
  dayLabel, filterRows, folderOf, groupRows, hasUnseenPush, mergeRows, mustReadOnShow, skipDelay, rowsDiffer, statusWord, totalsOf, visibleRows, whenLabel,
} from "../src/lib/changeRows.ts";
import type { ChangeRow } from "../../shared/types.ts";

const row = (over: Partial<ChangeRow> = {}): ChangeRow => ({
  key: `${over.repoRoot ?? "/w/one"}\0${over.path ?? "src/app.ts"}`,
  repoRoot: "/w/one",
  branch: "feat/checkout-rail",
  path: "src/app.ts",
  status: "modified",
  staged: "none",
  additions: 3,
  deletions: 1,
  binary: false,
  tooBig: false,
  changedAt: 1_700_000_000_000,
  ignored: false,
  outside: false,
  ...over,
});

describe("noticing that something changed", () => {
  it("sees an edit to a file that is already in the list", () => {
    /*
     * The one that made the view feel dead. The old poll compared row IDS, and
     * the id was a hash of (staged?, path) — nothing to do with content — so
     * editing a file with the view open produced an identical id set, the new
     * array was thrown away, and the diff, the +/− numbers and the totals all
     * stayed at what they were when the view was opened.
     */
    const before = [row({ additions: 3, changedAt: 1000 })];
    const after = [row({ additions: 9, changedAt: 2000 })];
    expect(rowsDiffer(before, after)).toBe(true);
  });

  it("sees a file being staged", () => {
    expect(rowsDiffer([row({ staged: "none" })], [row({ staged: "full" })])).toBe(true);
  });

  it("says nothing changed when nothing did, so the reader is not moved", () => {
    expect(rowsDiffer([row()], [row()])).toBe(false);
  });
});

describe("what a section is called", () => {
  it("is the branch, not the folder and not a session id", () => {
    /* The old grouping keyed on `source_app:session_id`, which for a git row was
       the literal string "staged" or "unstaged" — so the whole fleet collapsed
       into two sections named `git:staged` and `git:unstaged`. */
    const gs = groupRows([row(), row({ repoRoot: "/w/two", branch: "fix/usage-counter", key: "/w/two\0a.ts" })], "worktree");
    expect(gs.map((g) => g.label)).toEqual(["feat/checkout-rail", "fix/usage-counter"]);
  });

  it("keeps two checkouts apart even when they hold the same relative path", () => {
    // Two worktrees of one repo both have `src/app.ts`. Keyed on the path alone
    // they became one row, and one of the two changes silently vanished.
    const gs = groupRows([row(), row({ repoRoot: "/w/two", key: "/w/two\0src/app.ts" })], "worktree");
    expect(gs).toHaveLength(2);
  });

  it("sums each section from its own rows", () => {
    const gs = groupRows([row({ additions: 2, deletions: 1 }), row({ key: "/w/one\0b.ts", additions: 5, deletions: 0 })], "worktree");
    expect(gs[0]).toMatchObject({ add: 7, del: 1 });
  });

  it("groups by day when asked, which only means anything now the times are real", () => {
    const day = 86_400_000;
    const now = new Date("2026-08-13T12:00:00").getTime();
    const gs = groupRows([row({ changedAt: now }), row({ key: "b", changedAt: now - day })], "time", now);
    expect(gs.map((g) => g.label)).toEqual(["Today", "Yesterday"]);
  });
});

describe("how a time is written", () => {
  const now = new Date("2026-08-13T12:00:00").getTime();

  it("says the clock alone for today, and the day as well for anything older", () => {
    /* A row from Monday used to read `09:14:02` with no date anywhere, on a list
       whose stamps were all the time of the request in the first place. */
    expect(whenLabel(new Date("2026-08-13T09:14:00").getTime(), now)).toBe("09:14");
    expect(whenLabel(new Date("2026-08-12T09:14:00").getTime(), now)).toBe("Yesterday 09:14");
  });

  it("names a weekday inside the week and a date past it", () => {
    expect(dayLabel(new Date("2026-08-11T10:00:00").getTime(), now)).toBe("Tuesday");
    expect(dayLabel(new Date("2026-07-11T10:00:00").getTime(), now)).toMatch(/Jul|jul/);
  });

  it("admits it does not know rather than printing the epoch", () => {
    // A deleted file whose directory is gone too has no time to report. "—" is
    // an answer; 1 January 1970 is a lie.
    expect(whenLabel(0, now)).toBe("—");
  });
});

describe("what the header counts", () => {
  it("counts the rows that are actually on screen", () => {
    /* The old header summed a list that still held the rows the ignored/outside
       chips were hiding, so the count never matched the list — and the review
       counter took its numerator from one list and its denominator from the
       other, which is how it could read 12/7. */
    const rows = [row(), row({ key: "b", additions: 1, deletions: 1 })];
    const shown = visibleRows(rows, false, false);
    const t = totalsOf(shown, new Set(["/w/one\0src/app.ts"]));
    expect(t).toMatchObject({ files: 2, add: 4, del: 2, done: 1 });
    expect(t.done).toBeLessThanOrEqual(t.files);
  });

  it("hides what the chips say it hides — which the old flags could not do", () => {
    // `ignored` and `outside` were asserted false for every git row, so the
    // chips counted nothing and hid nothing.
    const rows = [row(), row({ key: "b", ignored: true }), row({ key: "c", outside: true })];
    expect(visibleRows(rows, false, false)).toHaveLength(1);
    expect(visibleRows(rows, true, false)).toHaveLength(2);
    expect(visibleRows(rows, true, true)).toHaveLength(3);
  });
});

describe("the smaller rules", () => {
  it("names what happened to a file the reader cannot read from a diff", () => {
    // Both of these rendered as an empty pane with "0 hunks" before.
    expect(statusWord(row({ status: "renamed" }))).toBe("renamed");
    expect(statusWord(row({ binary: true }))).toBe("binary");
    expect(statusWord(row())).toBe("");
  });

  it("filters on the branch and the checkout, not only on the file name", () => {
    const rows = [row(), row({ key: "b", repoRoot: "/w/two", branch: "fix/usage-counter", path: "web/usage.ts" })];
    expect(filterRows(rows, "usage-counter")).toHaveLength(1);
    expect(filterRows(rows, "app.ts")).toHaveLength(1);
    expect(filterRows(rows, "")).toHaveLength(2);
  });

  /*
   * The contract behind "Open its changes in File changes".
   *
   * Four buttons hand this list a worktree's FOLDER NAME as the filter — the
   * terminal's header, two in its worktree picker, and the pull request's own — so
   * the folder has to select that checkout's rows and nothing else. It works
   * because the filter reads `repoRoot`, which is the whole path.
   */
  it("a worktree's folder name selects that checkout, and not its neighbours", () => {
    const rows = [
      row({ key: "a", repoRoot: "/home/dev/code/orbit", branch: "main", path: "src/app.ts" }),
      row({ key: "b", repoRoot: "/home/dev/code/orbit-1042", branch: "orbit-1042-counter", path: "src/plan.ts" }),
      row({ key: "c", repoRoot: "/home/dev/code/orbit-1099", branch: "orbit-1099-rail", path: "src/rail.ts" }),
    ];
    expect(filterRows(rows, "orbit-1042").map((r) => r.key)).toEqual(["b"]);
    // And the parent checkout is a substring of both children, which is why a jump
    // sends the child's name rather than the repository's.
    expect(filterRows(rows, "orbit").map((r) => r.key)).toEqual(["a", "b", "c"]);
  });

  it("shortens a deep folder without losing which one it is", () => {
    expect(folderOf("src/app.ts")).toBe("src");
    expect(folderOf("a/b/c/d/app.ts")).toBe("…/c/d");
    expect(folderOf("app.ts")).toBe("./");
  });
});

describe("side pane: a refresh merges, a tab switch reuses", () => {
  it("keeps the identity of every row that did not change", () => {
    const prev = Array.from({ length: 40 }, (_, i) => row({ path: `src/f${i}.ts` }));
    const next = prev.map((r, i) => (i === 7 ? { ...r, additions: 99 } : { ...r }));
    const merged = mergeRows(prev, next);
    const reused = merged.filter((r, i) => r === prev[i]).length;
    expect(reused).toBe(39); // before the merge helper: 0 of 40 (the whole list was replaced)
    expect(merged[7]!.additions).toBe(99);
  });
  it("returns the same list when nothing differs", () => {
    const prev = [row(), row({ path: "b.ts" })];
    expect(mergeRows(prev, prev.map((r) => ({ ...r })))).toBe(prev);
  });
  it("follows the new order and drops removed rows", () => {
    const a = row({ path: "a.ts" }), b = row({ path: "b.ts" });
    const out = mergeRows([a, b], [{ ...b }, row({ path: "c.ts" })]);
    expect(out.map((r) => r.path)).toEqual(["b.ts", "c.ts"]);
    expect(out[0]).toBe(b);
  });
  it("a tab switch sends nothing when no git push came and the last read is recent", () => {
    let calls = 0;
    const show = (last: number | null, dirty: boolean, now: number) => { if (mustReadOnShow(last, dirty, now)) calls++; };
    show(null, false, 0); // first show reads
    for (let i = 0; i < 10; i++) show(1000, false, 1000 + i * 500); // ten switches in 5 s
    expect(calls).toBe(1); // before: 11
  });
  it("reads again after a git push or past the safety window", () => {
    expect(mustReadOnShow(1000, true, 1500)).toBe(true);
    expect(mustReadOnShow(1000, false, 1000 + 15_000)).toBe(true);
  });
  it("sees a change to branch or oldPath, and merge hands back the new object", () => {
    expect(rowsDiffer([row()], [row({ branch: "other" })])).toBe(true);
    expect(rowsDiffer([row({ oldPath: "a.ts" })], [row({ oldPath: "b.ts" })])).toBe(true);
    expect(rowsDiffer([row({ binary: false })], [row({ binary: true })])).toBe(true);
    const prev = [row(), row({ path: "b.ts" })];
    const out = mergeRows(prev, [row({ branch: "other" }), { ...prev[1]! }]);
    expect(out[0]!.branch).toBe("other");
    expect(out[1]).toBe(prev[1]);
  });
  it("a failed read leaves the pushes unseen; a push during a read stays unseen", () => {
    let seq = 0, seen = 0;
    seq++; // hidden git push
    // read fails: seen is not moved
    expect(hasUnseenPush(seq, seen)).toBe(true);
    const at = seq; seq++; // read starts, a push lands, read succeeds
    seen = at;
    expect(hasUnseenPush(seq, seen)).toBe(true);
    seen = seq;
    expect(hasUnseenPush(seq, seen)).toBe(false);
  });
  it("a skipped show reads when the last read's 15 s ends, not 15 s after the show", () => {
    expect(skipDelay(0, 14_000)).toBe(1_000); // before: next poll at 29 s
    expect(skipDelay(0, 20_000)).toBe(0);
    expect(mustReadOnShow(5_000, false, 1_000)).toBe(true); // clock set back
  });
});

describe("what sameRow may assume about a row", () => {
  it("every field is a primitive except commit, so a new object field fails here", () => {
    const full: Required<ChangeRow> = { ...row(), oldPath: "src/old.ts", commit: { hash: "abc1234", subject: "add thing", author: "Ada", at: 1 } };
    for (const [k, v] of Object.entries(full)) {
      if (k === "commit") continue;
      expect(v === null || typeof v !== "object", `${k} is an object: teach sameRow to compare it`).toBe(true);
    }
  });
  it("a changed commit field is a change, an equal copy is not", () => {
    const c = { hash: "a", subject: "s", author: "u", at: 1 };
    expect(rowsDiffer([row({ commit: c })], [row({ commit: { ...c } })])).toBe(false);
    expect(rowsDiffer([row({ commit: c })], [row({ commit: { ...c, at: 2 } })])).toBe(true);
  });
});
