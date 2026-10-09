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
import { LEAVE_ALONE, mergeCardRef, movesCard, mergeNote, statusColor, statusOptions, readyForQaStatus, handoffChanges, handoffRemovals } from "../src/lib/cardMove.ts";
import type { HandoffConfig, ListStatus } from "../../shared/providers.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

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

  it("sends a refused token to Settings instead of inviting a retry", () => {
    // The one failure here that pressing the button again cannot fix. Without
    // this, "ClickUp refused this token" reads as a hiccup.
    const said = mergeNote(true, { asked: true, ok: false, unauthorised: true, error: "ClickUp refused this token" });
    expect(said).toContain("Merged");
    expect(said).toContain("Reconnect it in Settings");
  });

  it("still leads with the merge when the token was refused", () => {
    expect(mergeNote(true, { asked: true, ok: false, unauthorised: true })).toStartWith("Merged");
    // And a merge that did NOT land is still reported as a failed merge,
    // whatever ClickUp thought of the token.
    expect(mergeNote(false, { asked: true, unauthorised: true })).toBe("Merge failed");
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

describe("finding the list's own ready-for-QA status", () => {
  it("matches the name the list gave it, whatever the case", () => {
    // A workspace spells it "Ready for QA"; another writes it in lowercase. The
    // word is theirs, and this control has no business assuming one spelling.
    const board = [s("To Do", 0), s("Ready for QA", 1), s("Done", 2, "done")];
    expect(readyForQaStatus(board, "To Do")).toBe("Ready for QA");
    expect(readyForQaStatus([s("To Do", 0), s("ready for qa", 1)], "To Do")).toBe("ready for qa");
  });

  it("offers nothing when the card is already there", () => {
    const board = [s("To Do", 0), s("Ready for QA", 1)];
    expect(readyForQaStatus(board, "Ready for QA")).toBeUndefined();
    expect(readyForQaStatus(board, "ready for qa")).toBeUndefined();
  });

  it("offers nothing when the list has no such status at all", () => {
    // Naming a near-miss ("QA", "Ready") would move the card to a status
    // nobody meant — silence is the honest answer here, not a guess.
    const board = [s("To Do", 0), s("QA", 1), s("Ready", 2)];
    expect(readyForQaStatus(board, "To Do")).toBeUndefined();
  });
});

describe("the hand-off, as the workspace configured it", () => {
  const on = (over: Partial<HandoffConfig> = {}): HandoffConfig => ({ enabled: true, statusNames: [], unassign: "all", assign: { who: "none" }, ...over });
  const board = [s("To Do", 0), s("Ready for QA", 1), s("TESTING", 2), s("Done", 3, "done")];

  it("offers nothing while the setting is off, however well the board matches", () => {
    // Off is the shipped default: "Ready for QA" is one team's column.
    expect(readyForQaStatus(board, "To Do", on({ enabled: false }))).toBeUndefined();
    expect(readyForQaStatus(board, "To Do", on({ enabled: false, statusNames: ["Testing"] }))).toBeUndefined();
  });

  it("matches the configured name without regard to case, and returns the list's spelling", () => {
    expect(readyForQaStatus(board, "To Do", on({ statusNames: ["Testing"] }))).toBe("TESTING");
  });

  it("tries the names in the order written and takes the first the list has", () => {
    expect(readyForQaStatus(board, "To Do", on({ statusNames: ["Handover", "testing", "ready for qa"] }))).toBe("TESTING");
    expect(readyForQaStatus(board, "To Do", on({ statusNames: ["ready for qa", "testing"] }))).toBe("Ready for QA");
  });

  it("falls back to the shipped name when enabled with no names", () => {
    expect(readyForQaStatus(board, "To Do", on())).toBe("Ready for QA");
  });

  it("offers nothing when none of the names exist, or the card is already there", () => {
    expect(readyForQaStatus(board, "To Do", on({ statusNames: ["Handover"] }))).toBeUndefined();
    expect(readyForQaStatus(board, "testing", on({ statusNames: ["Testing"] }))).toBeUndefined();
  });

  const people = [{ id: 1, me: true }, { id: 2 }, { id: 3 }];

  it("none sends no rem at all, me sends only the connected account, all sends everybody", () => {
    expect(handoffRemovals(people, "none")).toEqual([]);
    expect(handoffRemovals(people, "me")).toEqual([1]);
    expect(handoffRemovals(people, "all")).toEqual([1, 2, 3]);
    expect(handoffRemovals([{ id: 2 }], "me")).toEqual([]);
    expect(handoffRemovals(undefined, "all")).toEqual([]);
  });

  it("builds today's exact payload for everyone, and a bare status for nobody", () => {
    expect(JSON.stringify(handoffChanges("Ready for QA", people, "all"))).toBe('{"status":"Ready for QA","rem":[1,2,3]}');
    expect(JSON.stringify(handoffChanges("Ready for QA", people, "none"))).toBe('{"status":"Ready for QA"}');
    expect(JSON.stringify(handoffChanges("Ready for QA", people, "me"))).toBe('{"status":"Ready for QA","rem":[1]}');
    // Nobody on the card: no empty rem either, the same as before the setting.
    expect(JSON.stringify(handoffChanges("Ready for QA", [], "all"))).toBe('{"status":"Ready for QA"}');
  });

  it("goes over the wire as one POST whose body carries exactly those changes", async () => {
    const { api } = await import("../src/lib/api.ts");
    const seen: { url: string; body: unknown }[] = [];
    stubGlobal("fetch", async (url: string, init?: { body?: string }) => {
      seen.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
      return new Response(JSON.stringify({ ok: true }));
    });
    await api.clickupCard("86abc", handoffChanges("Ready for QA", people, "all"), 1700);
    await api.clickupCard("86abc", handoffChanges("Ready for QA", people, "none"), 1700);
    const posts = seen.filter((x) => x.url.endsWith("/clickup/card"));
    expect(posts.length).toBe(2);
    expect(posts[0]!.body).toEqual({ id: "86abc", updated: 1700, status: "Ready for QA", rem: [1, 2, 3] });
    expect(posts[1]!.body).toEqual({ id: "86abc", updated: 1700, status: "Ready for QA" });
  });
});

describe("the hand-off control in the panel", () => {
  const PANEL = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url).pathname, "utf8");
  const SETTINGS = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
  const fn = (src: string, head: string) => {
    const at = src.indexOf(head);
    expect(at).toBeGreaterThan(-1);
    const next = src.indexOf("\nfunction ", at + head.length);
    return src.slice(at, next < 0 ? undefined : next);
  };

  it("reads the workspace's setting and names no status of its own", () => {
    const body = fn(PANEL, "function CardReadyForQaButton(");
    expect(body).toContain("useClickupPrefs()");
    expect(body).toContain("readyForQaStatus(statuses, task.status, handoff)");
    const code = body.split("\n").filter((l) => !l.trim().startsWith("*") && !l.trim().startsWith("//")).join("\n");
    expect(code).not.toMatch(/Ready for QA/);
  });

  it("keeps the one write: a single clickupCard call with the built changes", () => {
    const body = fn(PANEL, "function CardReadyForQaButton(");
    expect(body.match(/api\.clickupCard\(/g)?.length).toBe(1);
    expect(body).toContain("stepChanges({ ...(target ? { status: target } : null), people: task.people, unassign: plan.unassign, ensure })");
  });

  it("shows the ClickUp page in Settings only for a connected ClickUp", () => {
    expect(SETTINGS).toContain('{show("clickup") && cu && <ClickUpPane />}');
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
