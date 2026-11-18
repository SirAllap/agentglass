/*
 * What a board card can do, and what its one press does (mock 62).
 *
 * The facts are a pull request in the lane that waits on the reader, with one
 * failed check and a base branch. The three cases worth pinning are the ones
 * that would be wrong by being generous: a read-only pairing, a green run, and
 * somebody else's pull request.
 */
import { describe, expect, test } from "bun:test";
import { actionRows, footerPress, lockSaid, rerunSaid } from "../src/model/prActions.ts";

const facts = (over: Partial<Parameters<typeof actionRows>[0]> = {}) => ({
  mayWrite: true, state: "OPEN" as const, forMe: true, failure: 1, base: "main", ...over,
});

const ids = (f: Parameters<typeof actionRows>[0]) => actionRows(f).map((r) => r.id);

describe("the actions sheet", () => {
  test("a review asked of you offers the verdicts, the re-run, the sync and the door", () => {
    expect(ids(facts())).toEqual(["approve", "changes", "comment", "reviewers", "watch", "rerun", "sync", "merge", "open"]);
  });

  test("a read-only pairing gets the door alone", () => {
    expect(ids(facts({ mayWrite: false }))).toEqual(["open"]);
  });

  test("a green run is not offered a re-run", () => {
    expect(ids(facts({ failure: 0 }))).toEqual(["approve", "changes", "comment", "reviewers", "watch", "sync", "merge", "open"]);
  });

  test("somebody else's pull request, not asked of you, gets no verdict", () => {
    expect(ids(facts({ forMe: false }))).toEqual(["comment", "reviewers", "watch", "rerun", "sync", "merge", "open"]);
  });

  test("a closed one can only be opened", () => {
    expect(ids(facts({ state: "CLOSED" }))).toEqual(["open"]);
  });

  test("the sync row names the base it merges", () => {
    const sync = actionRows(facts({ base: "trunk" })).find((r) => r.id === "sync");
    expect(sync?.sub).toContain("trunk");
  });
});

describe("the merge lock", () => {
  test("a lock that holds draws Merge off, with the lock's own sentence", () => {
    const merge = actionRows(facts({ mergeLock: "Waiting for #12 to merge" })).find((r) => r.id === "merge");
    expect(merge?.off).toBe("Waiting for #12 to merge");
    expect(merge?.sub).toContain("Waiting for #12 to merge");
  });

  test("no lock leaves Merge pressable", () => {
    expect(actionRows(facts({ mergeLock: null })).find((r) => r.id === "merge")?.off).toBeUndefined();
  });

  test("only a lock that holds counts; a failed read invents none", () => {
    expect(lockSaid({ ok: true, state: { locked: true, reason: "2 of 3 items ticked" } })).toBe("2 of 3 items ticked");
    expect(lockSaid({ ok: true, state: { locked: false, reason: "" } })).toBeNull();
    expect(lockSaid({ ok: true, state: null })).toBeNull();
    expect(lockSaid({ ok: false })).toBeNull();
    expect(lockSaid(null)).toBeNull();
  });
});

describe("the card's one press", () => {
  test("a phone that may write does what the lane implies", () => {
    expect(footerPress("rerun", true)).toBe("rerun");
    expect(footerPress("merge", true)).toBe("merge");
  });

  test("a read-only phone opens the pull request instead of writing", () => {
    expect(footerPress("rerun", false)).toBe("open");
    expect(footerPress("merge", false)).toBe("open");
  });
});

describe("what a re-run says", () => {
  test("the server's own words when it worked", () => {
    expect(rerunSaid(true, "Re-running build.")).toBe("Re-running build.");
  });

  test("a refusal is never reported as a re-run", () => {
    expect(rerunSaid(false)).toBe("GitHub refused the re-run.");
    expect(rerunSaid(false, "No failed run.")).toBe("No failed run.");
  });
});
