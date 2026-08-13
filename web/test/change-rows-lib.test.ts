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
  dayLabel, filterRows, folderOf, groupRows, rowsDiffer, statusWord, totalsOf, visibleRows, whenLabel,
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

  it("shortens a deep folder without losing which one it is", () => {
    expect(folderOf("src/app.ts")).toBe("src");
    expect(folderOf("a/b/c/d/app.ts")).toBe("…/c/d");
    expect(folderOf("app.ts")).toBe("./");
  });
});
