/*
 * Moving the card at merge time.
 *
 * The habit being replaced: merge here, then open ClickUp and drag the card
 * out of Code Review by hand — and sometimes forget. What is pinned here is
 * the part with consequences, because a wrong answer writes to a real board:
 * the select opens where the card already is, so leaving it alone writes
 * nothing; the order offered is the board's own workflow and not the
 * alphabet; and a failed card move never reads as a failed merge.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { LEAVE_ALONE, mergeCardRef, movesCard, mergeNote, statusColor, statusOptions } from "../src/lib/cardMove.ts";
import type { ListStatus } from "../../shared/providers.ts";

describe("which card is worth offering to move", () => {
  // Stricter than the chip that merely links to the card: this one writes to
  // somebody's board.
  const setup = (prefix?: string) => ({ connected: true, prefix });

  it("takes a ClickUp address in the body as proof, with no prefix needed", () => {
    const pr = { headRefName: "whatever", title: "x", body: "https://clickup.com/t/86abc123\n" };
    expect(mergeCardRef(pr, { connected: true })?.query).toBe("86abc123");
  });

  it("offers nothing at all without a ClickUp to write to", () => {
    // Evidence of a card is not evidence of a connection. A fork of a team that
    // uses ClickUp carries their addresses in its bodies, and the merge form
    // used to spin on "Looking up … on ClickUp" before admitting there was no
    // ClickUp here. Nothing to write with, so nothing to offer.
    const addressed = { headRefName: "whatever", title: "x", body: "https://clickup.com/t/86abc123\n" };
    const ours = { headRefName: "ORBIT-1042-rounding", title: "x", body: "" };
    expect(mergeCardRef(addressed, { connected: false })).toBe(null);
    expect(mergeCardRef(ours, { connected: false, prefix: "ORBIT-" })).toBe(null);
  });

  it("takes a branch id when the workspace's own prefix matches it", () => {
    const pr = { headRefName: "ORBIT-1042-rounding", title: "x", body: "" };
    expect(mergeCardRef(pr, setup("ORBIT"))?.label).toBe("ORBIT-1042");
  });

  it("says nothing when the branch id belongs to somebody else's tracker", () => {
    // A Jira shop's branches look exactly like this. Offering to move a card
    // that does not exist is worse than offering nothing.
    const pr = { headRefName: "ABC-12-thing", title: "x", body: "" };
    expect(mergeCardRef(pr, setup("ORBIT"))).toBe(null);
  });

  it("says nothing when we have never read a card id from this workspace", () => {
    // No prefix means no evidence. The chip can afford to guess; a write cannot.
    const pr = { headRefName: "ORBIT-1042-rounding", title: "x", body: "" };
    expect(mergeCardRef(pr, setup(undefined))).toBe(null);
    expect(mergeCardRef(pr, null)).toBe(null);
  });

  it("says nothing when the pull request names no card at all", () => {
    expect(mergeCardRef({ headRefName: "fix/rounding", title: "Round it", body: "" }, setup("ORBIT"))).toBe(null);
  });
});

const s = (status: string, orderindex: number, type = "custom"): ListStatus => ({ status, type, orderindex });

describe("the statuses on offer", () => {
  it("keeps the board's own workflow order", () => {
    // Alphabetical would sort the words; orderindex is the process as the team
    // drew it, and it is what makes the select aimable without reading it.
    const board = [s("Pre QA", 3), s("To Do", 0), s("Code Review", 2), s("In Development", 1)];
    expect(statusOptions(board, "Code Review").map((x) => x.status))
      .toEqual(["To Do", "In Development", "Pre QA"]);
  });

  it("never offers the status the card is already in", () => {
    // "Move ORBIT-1042 to Code Review" with Code Review already on it reads as
    // a promise to set the status it has. Leaving it alone is its own named
    // option now, so its status has no business in this list.
    const board = [s("To Do", 0), s("Code Review", 1)];
    expect(statusOptions(board, "code review").map((x) => x.status)).toEqual(["To Do"]);
  });

  it("offers the board unchanged when the card is in none of its statuses", () => {
    expect(statusOptions([s("B", 1), s("A", 0)], "Archived").map((x) => x.status)).toEqual(["A", "B"]);
  });
});

describe("whether confirming writes anything", () => {
  it("does nothing on the option that says it does nothing", () => {
    // This is what makes it safe to put on every merge: the dialog opens on
    // LEAVE_ALONE and confirming writes nothing at all.
    expect(movesCard("Code Review", LEAVE_ALONE)).toBe(false);
    expect(movesCard("Code Review", "Code Review")).toBe(false);
  });

  it("ignores the case the list happens to store", () => {
    // ClickUp compares status names case-insensitively and returns them in the
    // list's own case. Without this, a round-tripped status would post a
    // pointless write on every single merge.
    expect(movesCard("Code Review", "code review")).toBe(false);
    expect(movesCard("code review", "  CODE REVIEW  ")).toBe(false);
  });

  it("moves when a different status is picked", () => {
    expect(movesCard("Code Review", "Pre QA")).toBe(true);
  });

  it("does nothing on an empty pick", () => {
    expect(movesCard("Code Review", "")).toBe(false);
    expect(movesCard("Code Review", "   ")).toBe(false);
  });
});

describe("what it says afterwards", () => {
  it("never reports a merge that landed as a failure", () => {
    // Two writes to two systems. A card that would not move must not send
    // somebody off to un-merge a pull request that is merged.
    expect(mergeNote(true, { asked: true, ok: false, error: "403" }))
      .toBe("Merged — but the card did not move: 403");
  });

  it("says where the card went when it went", () => {
    expect(mergeNote(true, { asked: true, ok: true, to: "Pre QA" })).toBe("Merged · card moved to Pre QA");
  });

  it("says just the merge when no card was asked about", () => {
    expect(mergeNote(true, { asked: false })).toBe("Merged");
  });

  it("says the merge failed when the merge failed", () => {
    expect(mergeNote(false, { asked: true })).toBe("Merge failed");
  });

  it("still names the merge first when ClickUp gave no reason at all", () => {
    expect(mergeNote(true, { asked: true, ok: false })).toBe("Merged — but the card did not move: ClickUp refused");
  });
});

describe("the panel", () => {
  const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname, "utf8");

  it("only touches the board after the merge actually landed", () => {
    // Two writes to two systems. Moving the card off Code Review for a merge
    // that gh refused would leave the board claiming work shipped that did not
    // — and the panel already knows better, because `act` hands back whether
    // it worked.
    expect(PANEL).toMatch(/if \(!merged \|\| !move\) return;[\s\S]{0,600}clickupStatus\(/);
  });

  it("asks before it moves anything", () => {
    // The status has to come from the dialog's answer, never from a constant:
    // a hard-coded "Done" is exactly the shape of bug the merge method had.
    expect(PANEL).toContain("choice.card");
    expect(PANEL).not.toMatch(/clickupStatus\([^)]*["'][A-Za-z ]+["']/);
  });
});

describe("the colour a status is drawn in", () => {
  it("is the board's own, when the board gave one", () => {
    // Boards are read by colour before they are read by word.
    const board = [{ status: "Code Review", type: "custom", orderindex: 2, color: "#f9d900" }];
    expect(statusColor(board, "code review")).toBe("#f9d900");
  });

  it("is nothing rather than something invented", () => {
    // A made-up colour standing beside real ones reads as a real one.
    expect(statusColor([s("To Do", 0)], "To Do")).toBeUndefined();
    expect(statusColor([s("To Do", 0)], "Nowhere")).toBeUndefined();
  });
});
