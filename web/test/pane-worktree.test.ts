/*
 * How long the terminal's chip goes on believing a worktree.
 *
 * The bug this pins, in his words: "I've cleared the claude session and the
 * top bar still shows up… what is it trusting?". It was trusting the last worktree
 * that pane's agent ever named, with no way for that trust to expire — and
 * `/clear` is exactly the case where it must, because the conversation that
 * named the branch no longer exists.
 *
 * Both directions matter and they pull against each other: forget too eagerly
 * and the chip empties itself every time an agent thinks for a minute; forget
 * too late and it names a branch nobody is on.
 */
import { describe, expect, test } from "bun:test";
import { nextSeen } from "../src/lib/paneWorktree.ts";

const seen = { root: "/home/dev/code/orbit-1042", session: "s-1" };

describe("what a pane keeps believing", () => {
  test("a fresh detection always wins", () => {
    expect(nextSeen(undefined, "/home/dev/code/orbit-2001", "s-9"))
      .toEqual({ root: "/home/dev/code/orbit-2001", session: "s-9" });
    // Including one that moves the pane to another worktree mid-session.
    expect(nextSeen(seen, "/home/dev/code/orbit-2001", "s-1"))
      .toEqual({ root: "/home/dev/code/orbit-2001", session: "s-1" });
  });

  /* The reason stickiness exists: an agent that has not run a tool in ten
     minutes is still working where it was. */
  test("the same agent going quiet keeps it", () => {
    expect(nextSeen(seen, null, "s-1")).toEqual(seen);
  });

  test("a new session forgets it — this is the /clear case", () => {
    expect(nextSeen(seen, null, "s-2")).toBeNull();
  });

  test("no agent at all forgets it too", () => {
    // A pane with a plain shell in it. The panel's own checkout is the honest
    // answer there, not the last branch anybody saw.
    expect(nextSeen(seen, null, "")).toBeNull();
    expect(nextSeen(undefined, null, "")).toBeNull();
  });

  test("nothing remembered and nothing found stays nothing", () => {
    expect(nextSeen(undefined, null, "s-1")).toBeNull();
  });
});

describe("a read that did not happen", () => {
  test("is not news: the memory stays, whoever is in the pane", () => {
    /* The server was busy or offline. Forgetting on that dropped the chip to
       the panel's own checkout on every hiccup — and for a pane whose agent
       has no hooked session, nothing else could keep it. */
    expect(nextSeen(seen, null, "s-1", false)).toEqual(seen);
    expect(nextSeen({ root: seen.root, session: "" }, null, "", false)).toEqual({ root: seen.root, session: "" });
    expect(nextSeen(undefined, null, "", false)).toBeNull();
  });
});

describe("a worktree the list has not caught up with", () => {
  const cands = [{ root: "/home/dev/code/orbit" }, { root: "/home/dev/code/orbit-1042" }];
  test("is the directory the agent stands in that no candidate names — asked about once", async () => {
    const { unlistedWorktree } = await import("../src/lib/paneWorktree.ts");
    const asked = new Set<string>();
    expect(unlistedWorktree(["/home/dev/code/orbit-2001"], cands, asked)).toBe("/home/dev/code/orbit-2001");
    expect(unlistedWorktree(["/home/dev/code/orbit-2001"], cands, asked), "not again on the next poll").toBeNull();
    expect(unlistedWorktree(["/home/dev/code/orbit-1042/src"], cands, asked), "inside a candidate is known").toBeNull();
    expect(unlistedWorktree([], cands, asked)).toBeNull();
  });
});
