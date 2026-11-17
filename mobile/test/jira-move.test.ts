/*
 * Moving a Jira card: when the button is live, what it says when it is not,
 * and exactly what the POST carries.
 *
 * The bug this pins down is the one the plan calls out: the site's transition
 * asks for a field, the phone posts without it, and the person learns about it
 * from a 400 after a gesture. So a required field blocks the button, the button
 * names the field, and the body is built only from the transition's own screen —
 * never from values that belong to another move.
 */
import { describe, expect, test } from "bun:test";
import type { JiraMove } from "../../shared/providers.ts";
import type { Answer } from "../src/lib/api.ts";
import { jiraMoveOutcome, movePlan, moveValues, requiredFields } from "../src/model/jiraMove.ts";
import { holdsToConfirm } from "../src/model/confirmPolicy.ts";

const review: JiraMove = {
  id: "31", name: "Send for review", label: "In review", toStatus: "In review", toKind: "other",
  needs: ["reviewer", "comment"],
  fields: [
    { key: "reviewer", name: "Reviewer", required: true, kind: "option", choices: [{ id: "u1", name: "Ana" }, { id: "u2", name: "Noa" }] },
    { key: "comment", name: "Comment", required: false, kind: "comment" },
  ],
};

const done: JiraMove = {
  id: "41", name: "Finish", label: "Done", toStatus: "Done", toKind: "done",
  needs: ["resolution"],
  fields: [{ key: "resolution", name: "Resolution", required: true, kind: "option", choices: [{ id: "r1", name: "Fixed" }, { id: "r2", name: "Won't do" }] }],
};

describe("the move sheet's button", () => {
  test("no target yet: it says so and does nothing", () => {
    const plan = movePlan("ORBIT-1042", "In progress", null, {});
    expect(plan.enabled).toBe(false);
    expect(plan.label).toBe("Choose where it moves");
    expect(plan.why).toContain("Pick a target");
  });

  test("a required field blocks the press and names itself", () => {
    const plan = movePlan("ORBIT-1042", "In progress", review, {});
    expect(plan.enabled).toBe(false);
    expect(plan.label).toBe("Choose Reviewer");
    expect(plan.why).toBe("That move needs Reviewer");
    expect(plan.check?.ok).toBe(false);
    expect(plan.check?.ok === false && plan.check.bad).toEqual(["reviewer"]);
  });

  test("filled in, it is live and says where it goes", () => {
    const plan = movePlan("ORBIT-1042", "In progress", review, { reviewer: "u1" });
    expect(plan.enabled).toBe(true);
    expect(plan.label).toBe("Move to In review");
    expect(plan.why).toBeNull();
  });

  test("the card already there is not moved to where it is", () => {
    const plan = movePlan("ORBIT-1042", "In review", review, { reviewer: "u1" });
    expect(plan.enabled).toBe(false);
    expect(plan.label).toBe("Already in In review");
  });

  test("what will happen is listed before the press, in the site's own field names", () => {
    const plan = movePlan("ORBIT-1042", "In progress", review, { reviewer: "u2", comment: "On its way" });
    expect(plan.effects[0]).toBe("Moves ORBIT-1042 from In progress to In review");
    expect(plan.effects).toContain("Sets Reviewer to Noa");
    expect(plan.effects).toContain("Adds your comment");
  });

  test("the fields the transition insists on are the summary row's", () => {
    expect(requiredFields(review).map((f) => f.name)).toEqual(["Reviewer"]);
    expect(requiredFields(done).map((f) => f.name)).toEqual(["Resolution"]);
    expect(requiredFields(null)).toEqual([]);
  });
});

describe("the body", () => {
  test("it is the transition's own fields, filled ones only", () => {
    const check = moveValues(review, { reviewer: "u1", comment: "  " });
    expect(check.ok).toBe(true);
    expect(check.ok && check.values).toEqual({ reviewer: "u1" });
  });

  test("a value the move does not ask for is named, never sent", () => {
    const check = moveValues(review, { reviewer: "u1", resolution: "r1" });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.error).toContain("does not ask for that field");
  });

  test("a choice that is not the site's is refused, not posted", () => {
    const check = moveValues(review, { reviewer: "somebody-else" });
    expect(check.ok).toBe(false);
    expect(check.ok === false && check.error).toContain("not one of the choices");
  });

  test("a done move names its resolution and nothing else", () => {
    const check = moveValues(done, { resolution: "r1" });
    expect(check.ok && check.values).toEqual({ resolution: "r1" });
    expect(moveValues(done, {}).ok).toBe(false);
  });
});

describe("the hold, and the answer", () => {
  test("finishing a card holds; moving between open statuses is a tap", () => {
    expect(holdsToConfirm("jira.done")).toBe(true);
    expect(holdsToConfirm("jira.move")).toBe(false);
  });

  test("a 409 is a conflict, not a failure to retry blindly", () => {
    const answer: Answer<{ ok: boolean; error?: string }> = { ok: false, error: "Somebody changed this card", status: 409 };
    expect(jiraMoveOutcome(answer)).toEqual({ kind: "conflict" });
  });

  test("a 200 that carries a refusal keeps its sentence", () => {
    expect(jiraMoveOutcome({ ok: true, value: { ok: false, error: "Writing to Jira is switched off" } }))
      .toEqual({ kind: "failed", text: "Writing to Jira is switched off" });
  });

  test("a move that landed gives the card as it now is", () => {
    const task = { id: "1", customId: "ORBIT-1042", status: "In review" } as never;
    expect(jiraMoveOutcome({ ok: true, value: { ok: true, task, was: "In progress" } }))
      .toEqual({ kind: "moved", task, was: "In progress" });
  });
});
