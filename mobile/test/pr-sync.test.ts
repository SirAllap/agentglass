/*
 * Syncing a branch, as the answers say it happened.
 *
 * The one number worth pinning down is "accepted": a lane sync is N calls to a
 * route that has no bulk form, and a summary that counted an attempted call as
 * a synced branch is how a board tells somebody their green lane is current
 * while a conflict sits in it. The other half is the refusal: a conflict, a
 * queued request and a failure all leave the branch exactly where it was, and
 * each says so in the same sentence.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  UNTOUCHED, behindLine, bringLine, incomingLines, outcomeOf, outcomeWord, skippedOutcome, syncCount,
  syncSubtitle, syncSummary, syncTitle, unreachableOutcome, unreadOutcome, type SyncTarget,
} from "../src/model/prSync.ts";

const target = (o: Partial<SyncTarget> = {}): SyncTarget => ({ number: 184, ...o });

describe("how far behind, and what the base brings", () => {
  test("an unread comparison is not zero", () => {
    expect(behindLine(target(), "main")).toContain("unread");
    expect(behindLine(target({ behind: 0 }), "main")).toContain("Up to date");
  });

  test("one commit and three commits are said differently", () => {
    expect(behindLine(target({ behind: 1 }), "main")).toBe("Behind main by 1 commit");
    expect(behindLine(target({ behind: 3 }), "main")).toBe("Behind main by 3 commits");
  });

  test("the comparison's two numbers are both drawn", () => {
    expect(bringLine(target({ behind: 3, ahead: 1 }), "main"))
      .toContain("main is 3 commits ahead; this branch has 1 commit main does not");
    expect(bringLine(target({ behind: 0 }), "main")).toContain("nothing this branch is missing");
  });
});

describe("a sync is one call per branch that needs it", () => {
  test("only the behind ones are counted", () => {
    expect(syncCount([target({ number: 1, behind: 3 }), target({ number: 2, behind: 0 }), target({ number: 3 })]))
      .toBe(1);
  });

  test("one branch is named, several are counted", () => {
    expect(syncTitle([target({ number: 7 })], "main")).toBe("Sync #7 with main");
    expect(syncTitle([target({ number: 7 }), target({ number: 8 })], "main")).toBe("Sync 2 branches with main");
  });

  test("the subtitle says how many of the lane are behind", () => {
    const lane = [target({ number: 1, behind: 2 }), target({ number: 2, behind: 0 }), target({ number: 3, behind: 1 })];
    expect(syncSubtitle(lane, "main")).toContain("2 of 3");
    expect(syncSubtitle([target({ number: 9, behind: 0 })], "main")).toContain("up to date");
  });

  test("one branch reads as the mock's line: branch, how far, and whether it applies", () => {
    expect(syncSubtitle([target({ number: 7, behind: 3, head: "feat/ORBIT-1042" })], "main"))
      .toBe("feat/ORBIT-1042 · behind 3 · no conflicts");
    expect(syncSubtitle([target({ number: 7, behind: 3, conflict: true, head: "feat/ORBIT-1042" })], "main"))
      .toBe("feat/ORBIT-1042 · behind 3 · conflicts");
  });
});

describe("what the server's answer means", () => {
  test("a conflict says the branch is untouched", () => {
    const out = outcomeOf(184, { ok: false, conflict: true, error: "GitHub would not update it." });
    expect(out.status).toBe("conflict");
    expect(out.untouched).toBe(true);
    expect(out.line).toContain("untouched");
    expect(out.line).toContain(UNTOUCHED);
  });

  test("a queued request is not a sync: GitHub accepted it and the branch did not move", () => {
    const out = outcomeOf(184, { ok: true, requested: true, detail: "Update requested — GitHub has not moved the branch yet." });
    expect(out.status).toBe("requested");
    expect(out.untouched).toBe(true);
    expect(out.line).toContain("untouched");
  });

  test("a moved branch is the only outcome that does not promise it stayed put", () => {
    const out = outcomeOf(184, { ok: true, detail: "Synced — updated on GitHub." });
    expect(out.status).toBe("synced");
    expect(out.untouched).toBe(false);
  });

  test("a lagging pull request is its own answer rather than a plain failure", () => {
    const out = outcomeOf(184, { ok: false, prLagging: true, error: "GitHub updated it but the pull request has not caught up." });
    expect(out.status).toBe("lagging");
    expect(outcomeWord(out.status)).toBe("Not caught up");
  });

  test("anything else that failed still says nothing moved", () => {
    const out = outcomeOf(184, { ok: false, error: "that branch is protected" });
    expect(out.status).toBe("failed");
    expect(out.line).toContain("branch is protected");
    expect(out.untouched).toBe(true);
  });

  test("a request that never answered does not claim the branch stayed put", () => {
    const out = unreachableOutcome(184, "Cannot reach the computer");
    expect(out.status).toBe("unknown");
    expect(out.untouched).toBe(false);
    expect(out.line).toContain("unknown");
  });

  test("a branch with nothing to do is drawn, and counts as skipped", () => {
    const out = skippedOutcome(184, "main");
    expect(out.status).toBe("skipped");
    expect(outcomeWord(out.status)).toBe("Up to date");
  });
});

describe("the lane summary counts what the server moved", () => {
  test("a conflict and a failure are not synced, however many branches were tried", () => {
    const outcomes = [
      outcomeOf(1, { ok: true }),
      outcomeOf(2, { ok: false, conflict: true, error: "conflict in the rail" }),
      outcomeOf(3, { ok: false, error: "protected" }),
    ];
    const summary = syncSummary(outcomes, "main");
    expect(summary.synced).toBe(1);
    expect(summary.conflicts).toBe(1);
    expect(summary.failed).toBe(1);
    expect(summary.line).toContain("Synced 1 branch");
    expect(summary.line).not.toContain("Synced 3");
  });

  test("a queued request is not counted as a synced branch", () => {
    const summary = syncSummary([
      outcomeOf(1, { ok: true, requested: true, detail: "Update requested." }),
      outcomeOf(2, { ok: true }),
    ], "main");
    expect(summary.synced).toBe(1);
    expect(summary.line).toContain("Synced 1");
  });

  test("nothing to do says so instead of drawing a zero", () => {
    expect(syncSummary([skippedOutcome(1, "main")], "main").line).toContain("already up to date");
    expect(syncSummary([], "main").line).toBe("Nothing to sync.");
  });

  test("every branch is drawn, including the ones that were skipped", () => {
    const summary = syncSummary([skippedOutcome(1, "main"), skippedOutcome(2, "main")], "main");
    expect(summary.skipped).toBe(2);
    expect(summary.synced).toBe(0);
  });
});

describe("a branch nobody compared", () => {
  test("is not up to date, is not skipped, and does not let the summary say there was nothing to do", () => {
    const out = unreadOutcome(184, "main");
    expect(out.status).toBe("unread");
    expect(outcomeWord(out.status)).toBe("Not read");

    const summary = syncSummary([out], "main");
    expect(summary.skipped).toBe(0);
    expect(summary.unread).toBe(1);
    expect(summary.line).not.toContain("already up to date");
    expect(summary.line).toContain("not compared");

    // The subtitle over a whole lane is the same claim, said once for all of
    // them: an unread comparison is not "every one is up to date".
    const lane = syncSubtitle([target({ number: 1 }), target({ number: 2 })], "main");
    expect(lane).toContain("could not be compared");
  });

  test("the sheet asks for that status rather than calling an unread row up to date", () => {
    const sheet = readFileSync(join(import.meta.dir, "..", "src", "review", "SyncSheet.tsx"), "utf8");
    expect(sheet).toContain("t.behind === undefined");
    expect(sheet).toContain("unreadOutcome(t.number, base)");
  });
});

describe("what the base brings (mock 38, 'What main brings')", () => {
  test("lines are `sha title`, newest first, five at most", () => {
    const incoming = ["a11c2", "9f30d", "c4b1a", "d1", "d2", "d3"].map((sha, i) => ({ sha, title: `Commit ${i}` }));
    expect(incomingLines({ number: 1, behind: 6, incoming })).toEqual([
      "a11c2 Commit 0", "9f30d Commit 1", "c4b1a Commit 2", "d1 Commit 3", "d2 Commit 4",
    ]);
  });
  test("nothing read means no lines, not a placeholder", () => {
    expect(incomingLines({ number: 1, behind: 2 })).toEqual([]);
  });
});
