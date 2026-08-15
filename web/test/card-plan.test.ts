/*
 * What the picker says it will do, and what it does — one object, so they
 * cannot disagree.
 *
 * They did. The confirmation read "move it to Code Review, put Ana on it,
 * take you off it"; one of the three landed and the app said it had gone well.
 * The write was three calls sharing one precondition, and the summary was built
 * from a different list than the writes were. Now there is one plan: it is what
 * is shown and it is what is sent.
 */
import { describe, expect, it } from "bun:test";
import { cardPlan, cardPlanNote } from "../src/lib/cardPlan.ts";

const nameOf = (id: number) => ({ 1: "Rob", 2: "Ana", 3: "Kit" } as Record<number, string>)[id] ?? `#${id}`;
const plan = (o: Partial<Parameters<typeof cardPlan>[0]>) =>
  cardPlan({ label: "ORBIT-1042", pick: "", on: [], was: [], nameOf, ...o });

describe("what a visit to the card would change", () => {
  it("says nothing when nothing moved", () => {
    // The press is then a GitHub assignment and only that — no write goes to
    // somebody's company board to leave it exactly as it was.
    expect(plan({ on: [1], was: [1] })).toEqual({ add: [], drop: [], status: "", lines: [] });
  });

  it("does not count a status the card is already in", () => {
    // Reported: "esto no es nada, no deberíamos mandarlo". A card in Code
    // Review being moved to Code Review is a no-op that dates the card.
    expect(plan({ pick: "code review", statusNow: "code review" }).status).toBe("");
    expect(plan({ pick: "code review", statusNow: "in progress" }).status).toBe("code review");
  });

  it("counts who arrived and who left, separately", () => {
    const p = plan({ on: [2], was: [1] });
    expect(p.add).toEqual([2]);
    expect(p.drop).toEqual([1]);
  });

  it("reads back as the three things it will do, in order", () => {
    const p = plan({ pick: "code review", statusNow: "in progress", on: [2, 3], was: [1, 3] });
    expect(p.lines).toEqual([
      "Move ORBIT-1042 to code review",
      "Put Ana on the card",
      "Take Rob off the card",
    ]);
  });

  it("names somebody the member list does not know rather than dropping them", () => {
    // A card can carry an assignee who is not a member of the list it lives in.
    // Leaving them out of the summary while still taking them off the card is
    // the one thing this must never do.
    expect(plan({ on: [], was: [99] }).lines).toEqual(["Take #99 off the card"]);
  });

  it("holds the ids the write is built from, not just prose", () => {
    /* The whole point of one object: `run` sends `plan.add` / `plan.drop` /
       `plan.status`, so a line on the confirmation with no id behind it — or an
       id with no line — cannot happen. */
    const p = plan({ pick: "done", statusNow: "code review", on: [2], was: [] });
    expect(p.lines.length).toBe(2);
    expect({ add: p.add, drop: p.drop, status: p.status }).toEqual({ add: [2], drop: [], status: "done" });
  });
});

describe("what it says afterwards", () => {
  it("reports in the shape of what was asked for", () => {
    const p = plan({ pick: "code review", statusNow: "open", on: [2], was: [1] });
    expect(cardPlanNote(p, "ORBIT-1042")).toBe("ORBIT-1042 — moved to code review, 1 on, 1 off");
  });

  it("has something honest to say about an empty plan", () => {
    expect(cardPlanNote(plan({}), "ORBIT-1042")).toBe("ORBIT-1042 — nothing to change");
  });
});
