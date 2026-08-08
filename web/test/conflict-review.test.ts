/*
 * What the merge commit would carry, and why it is not simply the staged list.
 *
 * This bug was not reasoned about, it was photographed: the screen was driven
 * through a real merge of thirty-two files, two of them conflicted, and the
 * review that came up listed thirty files under the sentence "2 of these you
 * decided" — with neither of the two on it.
 *
 * The cause is that resolving a conflict in favour of the side you are already
 * on produces a file identical to HEAD. No diff, so `git diff --cached` does
 * not mention it and it is absent from everything built on that list. The
 * merge commit still records a resolution for that path; it is still a
 * decision somebody made; and a review that leaves it out is exactly the
 * "commits four hundred files, showed you one" failure this screen exists to
 * prevent, in miniature.
 */
import { describe, expect, it } from "bun:test";
import { reviewRows } from "../src/lib/mergeReview.ts";
import type { GitFileChange } from "../../shared/types.ts";

const ROOT = "/home/me/code/orbit";
const change = (path: string, additions = 1, deletions = 0): GitFileChange =>
  ({ file_path: path, status: "modified", additions, deletions, hunks: [] } as unknown as GitFileChange);

describe("the review list", () => {
  it("includes a decided file that produced no diff at all", () => {
    // The photographed bug, in one assertion.
    const rows = reviewRows(ROOT, ["config.ts", "retry.ts"], [change("mod-1.ts")]);
    expect(rows.map((r) => r.path)).toEqual(["config.ts", "retry.ts", "mod-1.ts"]);
    expect(rows[0]!.change).toBeUndefined();      // nothing staged for it
    expect(rows[0]!.decided).toBe(true);          // and it is still yours
  });

  it("puts every decided file first, whatever order they arrived in", () => {
    const rows = reviewRows(ROOT, ["z.ts"], [change("a.ts"), change("z.ts"), change("b.ts")]);
    expect(rows.map((r) => r.path)).toEqual(["z.ts", "a.ts", "b.ts"]);
    expect(rows.filter((r) => r.decided)).toHaveLength(1);
  });

  it("never lists a file twice when it is both decided and staged", () => {
    const rows = reviewRows(ROOT, ["config.ts"], [change("config.ts", 4, 2)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.change?.additions).toBe(4);
  });

  it("carries the counts through, so the row can show them", () => {
    const rows = reviewRows(ROOT, [], [change("a.ts", 12, 5)]);
    expect(rows[0]!.change?.additions).toBe(12);
    expect(rows[0]!.change?.deletions).toBe(5);
  });

  it("matches absolute staged paths against relative decided ones", () => {
    // The working tree reports absolute paths; the merge record keeps them
    // relative to the root. Getting this wrong lists everything twice.
    const rows = reviewRows(ROOT, ["src/config.ts"], [change(`${ROOT}/src/config.ts`, 3, 1)]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.decided).toBe(true);
    expect(rows[0]!.change?.additions).toBe(3);
  });

  it("counts the clean files as everything nobody decided", () => {
    // The rail and the review show this number in different words; they read
    // it from here so they cannot disagree.
    const rows = reviewRows(ROOT, ["config.ts"], [change("config.ts"), change("a.ts"), change("b.ts")]);
    expect(rows.filter((r) => !r.decided)).toHaveLength(2);
  });

  it("says nothing at all for a merge that carries nothing", () => {
    expect(reviewRows(ROOT, [], [])).toEqual([]);
  });
});
