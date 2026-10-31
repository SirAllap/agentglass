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
import { chipWorktree, nextSeen, paneCandidates, paneNote, readPaneSeen, vouchedSeen, pickWorktree } from "../src/lib/paneWorktree.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

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
    /* The pane's own buffer still answered: that is a detection, and it wins. */
    expect(nextSeen(undefined, "/home/dev/code/orbit-2001", "", false)).toEqual({ root: "/home/dev/code/orbit-2001", session: "" });
  });
});

describe("a worktree the list has not caught up with", () => {
  const cands = [{ root: "/home/dev/code/orbit" }, { root: "/home/dev/code/orbit-1042" }];
  test("is the directory the agent stands in that no candidate names — asked about once", async () => {
    const { unlistedWorktree } = await import("../src/lib/paneWorktree.ts");
    const asked = new Map<string, number>();
    expect(unlistedWorktree(["/home/dev/code/orbit-2001"], cands, asked, 1000)).toBe("/home/dev/code/orbit-2001");
    expect(unlistedWorktree(["/home/dev/code/orbit-2001"], cands, asked, 5000), "not again on the next poll").toBeNull();
    /* The server keeps its own list for some seconds, so the first re-read can
       still be the old one: asked again after a minute, not never. */
    expect(unlistedWorktree(["/home/dev/code/orbit-2001"], cands, asked, 1000 + 61_000), "asked again after a minute").toBe("/home/dev/code/orbit-2001");
    expect(unlistedWorktree(["/home/dev/code/orbit-1042/src"], cands, asked, 1000), "inside a candidate is known").toBeNull();
    expect(unlistedWorktree([], cands, asked, 1000)).toBeNull();
  });
});

describe("a remembered pane before it is read again", () => {
  const seen = { root: "/home/dev/code/orbit-1042", session: "ended-conversation" };

  test("a pane that got an ended session's id inherits nothing", () => {
    // A shell (no agent) or another agent now holds `@3:%5`.
    expect(vouchedSeen(seen, "")).toBeUndefined();
    expect(vouchedSeen(seen, "another-conversation")).toBeUndefined();
    expect(vouchedSeen(seen, undefined), "not read yet this run").toBeUndefined();
  });

  test("the same conversation still answers at once", () => {
    expect(vouchedSeen(seen, "ended-conversation")).toBe(seen);
  });

  test("a memory with no conversation behind it vouches for nothing", () => {
    expect(vouchedSeen({ root: "/home/dev/code/orbit", session: "" }, "")).toBeUndefined();
  });
});

/* The shape measured on a real pane: on main in the parent repo, the server
   read it and found no directories but did name the live conversation, and a
   memory said an ended session's worktree. */
describe("a tmux pane the server read and found nothing in", () => {
  const ended = { root: "/home/dev/code/orbit-ORBIT-1042" };
  test("names no worktree, whatever the panel was last pointed at", () => {
    expect(chipWorktree(null, false, true, ended)).toBeNull();
  });
  test("a shell that is not a tmux pane still falls back to where it was started", () => {
    expect(chipWorktree(null, false, false, ended)).toBe(ended);
  });
  test("the pane's own answer wins either way", () => {
    const live = { root: "/home/dev/code/orbit-ORBIT-2001" };
    expect(chipWorktree(live, false, true, ended)).toBe(live);
  });
  test("a memory written under the old key is dropped on load", () => {
    const store = new Map<string, string>([
      ["agentglass.term.paneSeen", JSON.stringify([["@731:%982", { root: ended.root, session: "d-live" }]])],
    ]);
    stubGlobal("localStorage", {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
    expect(readPaneSeen()).toEqual([]);
    expect(store.has("agentglass.term.paneSeen")).toBe(false);
  });
});

describe("which checkouts a pane directory is matched against", () => {
  const dev = "/home/dev/code";
  const orbit = { root: `${dev}/orbit` };
  const orbitWt = { root: `${dev}/orbit-1042`, worktreeOf: `${dev}/orbit` };
  const other = { root: `${dev}/acme`, worktreeOf: null };
  const dirs = ["/home/dev/code/orbit"];
  const hit = (cands: { root: string }[]) => cands.find((r) => dirs.some((p) => p === r.root || p.startsWith(r.root + "/")));

  test("a pane in the main checkout finds it, beside its worktrees", () => {
    const c = paneCandidates([orbit, orbitWt, other], orbit.root);
    expect(c.map((r) => r.root)).toEqual([orbit.root, orbitWt.root]);
    expect(hit(c)).toBe(orbit);
  });

  test("a repo with no worktree at all is still a candidate", () => {
    expect(hit(paneCandidates([orbit, other], orbit.root))).toBe(orbit);
  });

  test("the project asked for is named by a worktree too", () => {
    expect(paneCandidates([orbit, orbitWt], orbitWt.worktreeOf).length).toBe(2);
  });
});

describe("what the bar says when a pane has no chip", () => {
  test("a checkout outside the window's project is named, not denied", () => {
    expect(paneNote(false, null, "orbit", "acme")).toBe("orbit · outside this project (acme)");
  });
  test("nothing named at all is still no checkout", () => {
    expect(paneNote(false, null, "", "acme")).toBe("No checkout behind this pane");
  });
  test("a scanned-out dir and a read in flight keep their own words", () => {
    expect(paneNote(false, "/home/dev/code/orbit", "", "acme")).toBe("orbit — no repo scanned here");
    expect(paneNote(true, null, "orbit", "acme")).toBe("Reading this pane…");
    // A plain shell names its folder instead of a fault.
    expect(paneNote(false, null, "", "acme", "/home/dev/code/orbit/")).toBe("orbit · plain shell");
    expect(paneNote(false, null, "", "acme", "")).toBe("No checkout behind this pane");
  });
});

describe("pickWorktree: the chip follows work, the pane's checkout is the fallback", () => {
  const main = { root: "/home/dev/code/orbit" };
  const pr = { root: "/home/dev/code/orbit-ORBIT-1042" };
  const other = { root: "/home/dev/code/orbit-ORBIT-1043" };
  const cands = [main, pr, other];

  test("a session in the main checkout that only read the PR stays on the main checkout", () => {
    // The server puts the pane's own cwd first in dirs and the looked-at worktree behind it.
    expect(pickWorktree([], [main.root, pr.root + "/a.py"], cands)).toEqual({ hit: main, more: 0 });
  });

  test("an edit in the PR worktree moves it, and the main checkout is not asked", () => {
    expect(pickWorktree([pr.root + "/a.py"], [main.root], cands)).toEqual({ hit: pr, more: 0 });
  });

  test("two worktrees worked in: the newest, and the count of the rest", () => {
    expect(pickWorktree([pr.root + "/a.py", other.root, pr.root], [main.root], cands)).toEqual({ hit: pr, more: 1 });
  });

  test("work outside every known checkout falls back to where the pane stands", () => {
    expect(pickWorktree(["/tmp/scratch/x"], [main.root], cands)).toEqual({ hit: main, more: 0 });
  });
});
