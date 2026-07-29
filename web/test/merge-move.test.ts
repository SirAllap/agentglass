/*
 * What to do about a pull request that will not merge.
 *
 * The footer had one button and two states: "Squash & merge" when GitHub said
 * CLEAN, and a disabled "Blocked" the rest of the time. The reason was printed
 * above it, which is more than most review UIs manage — but for half the states
 * that reason names something the phone could have done and did not offer.
 * "The base branch has moved — update the branch first" sat above a dead
 * button, with `prUpdateBranch` in the client the whole time.
 */
import { describe, expect, it } from "bun:test";
import { mergeMove, MERGE_WHY, whyBlocked, type MergeInput } from "../src/mobile/mergeMove.ts";
import type { PrMergeState } from "../../shared/types.ts";

const STATES: PrMergeState[] =
  ["CLEAN", "BLOCKED", "BEHIND", "DIRTY", "UNSTABLE", "DRAFT", "HAS_HOOKS", "UNKNOWN"];

const pr = (over: Partial<MergeInput> = {}): MergeInput =>
  ({ state: "CLEAN", isDraft: false, ...over });

describe("the move on the primary button", () => {
  it("merges what is mergeable", () => {
    expect(mergeMove(pr())).toEqual({ kind: "merge", label: "Squash & merge" });
  });

  it("offers to update a branch that is merely behind", () => {
    // One call from mergeable, and the sentence above the button has been
    // telling people to do exactly this while offering no way to.
    expect(mergeMove(pr({ state: "BEHIND" })).kind).toBe("update");
  });

  it("arms auto-merge when the wait is the only problem", () => {
    // The move for someone who is not at their desk and will not be back to
    // press a button when the run goes green.
    expect(mergeMove(pr({ state: "BLOCKED" })).kind).toBe("auto");
    expect(mergeMove(pr({ state: "UNSTABLE" })).kind).toBe("auto");
  });

  it("re-runs instead of arming when something has actually failed", () => {
    // Auto-merge on a failing run waits for a failure. Fix the failure.
    expect(mergeMove(pr({ state: "UNSTABLE", anyFailing: true })).kind).toBe("rerun");
    expect(mergeMove(pr({ state: "BLOCKED", anyFailing: true })).kind).toBe("rerun");
  });

  it("does not offer to arm what is already armed", () => {
    const m = mergeMove(pr({ state: "BLOCKED", autoMerge: true }));
    expect(m.kind).toBe("none");
    expect(m.label).toBe("Merging when green");
  });

  it("prefers updating a behind branch over arming auto-merge", () => {
    // Ordered by what unblocks soonest, not by what sounds most capable.
    expect(mergeMove(pr({ state: "BEHIND", anyFailing: true })).kind).toBe("update");
    expect(mergeMove(pr({ state: "BEHIND", autoMerge: true })).kind).toBe("update");
  });

  it("admits that conflicts are not a phone job", () => {
    // Resolving against a base branch needs the machine with the checkout on
    // it. Offering it here would strand someone with no editor.
    const m = mergeMove(pr({ state: "DIRTY" }));
    expect(m.kind).toBe("none");
    expect(m.label).toBe("Conflicts");
  });

  it("leaves a draft alone", () => {
    // Being a draft is a decision somebody made; undrafting from the merge
    // button would be a surprise, and the ⋯ sheet has that verb.
    expect(mergeMove(pr({ state: "CLEAN", isDraft: true })).kind).toBe("none");
    expect(mergeMove(pr({ state: "DRAFT", isDraft: true })).kind).toBe("none");
  });

  it("never puts an empty or nonsense label on the button", () => {
    // The rule over the whole state type rather than over today's eight cases:
    // adding a state to PrMergeState must not produce a blank primary.
    for (const state of STATES) {
      for (const isDraft of [true, false]) {
        for (const anyFailing of [true, false]) {
          const m = mergeMove({ state, isDraft, anyFailing });
          expect(m.label.length).toBeGreaterThan(3);
          expect(m.label).not.toContain("undefined");
          expect(["merge", "update", "auto", "rerun", "none"]).toContain(m.kind);
        }
      }
    }
  });

  it("has a reason for every state it can be in", () => {
    for (const state of STATES) {
      expect(MERGE_WHY[state]).toBeTruthy();
      expect(MERGE_WHY[state]!.length).toBeGreaterThan(12);
    }
  });
});

describe("the reason above the button", () => {
  it("does not claim a failure when nothing has failed", () => {
    // GitHub's UNSTABLE covers both "a check failed" and "a check has not
    // finished". The fixed string said the first while the button offered the
    // move for the second, and someone acts on the sentence, not the button.
    expect(whyBlocked(pr({ state: "UNSTABLE", anyFailing: false }))).toBe("A check has not finished yet");
    expect(whyBlocked(pr({ state: "UNSTABLE", anyFailing: true }))).toBe("A check is failing");
  });

  it("names the failure when BLOCKED is really a red check", () => {
    expect(whyBlocked(pr({ state: "BLOCKED", anyFailing: true }))).toBe("A check is failing");
    expect(whyBlocked(pr({ state: "BLOCKED", anyFailing: false })))
      .toBe("A required review or check has not passed");
  });

  it("never disagrees with the move offered under it", () => {
    // The rule that matters: if the button says "Merge when green" the sentence
    // above it must not say something has already gone red, and the other way
    // round. This is the pair that was actually wrong on screen.
    for (const state of STATES) {
      for (const anyFailing of [true, false]) {
        const input = pr({ state, anyFailing });
        const said = whyBlocked(input);
        const kind = mergeMove(input).kind;
        if (kind === "auto") expect(said).not.toMatch(/is failing/);
        if (kind === "rerun") expect(said).toMatch(/failing/);
        expect(said.length).toBeGreaterThan(12);
      }
    }
  });
});
