import { describe, expect, test } from "bun:test";
import { whatMoved } from "../src/lib/conflictSentence.ts";
import { plainFailure } from "../src/lib/jiraStepPlan.ts";

describe("conflict sentence", () => {
  const named = "This card changed while you had it open: its status is now Done, it is now assigned to Ada Orbit. Reloaded";

  test("the server's named sentence is shown, without its Reloaded tail", () => {
    expect(whatMoved(named)).toBe("This card changed while you had it open: its status is now Done, it is now assigned to Ada Orbit");
    expect(plainFailure({ ok: false, conflict: true, error: named })).toBe(
      "This card changed while you had it open: its status is now Done, it is now assigned to Ada Orbit. Nothing in Jira was changed.",
    );
  });

  test("no sentence from the server: null, so each screen keeps its generic line", () => {
    expect(whatMoved(undefined)).toBeNull();
    expect(whatMoved("Somebody changed this card while you had it open, reloaded")).toBeNull();
    expect(plainFailure({ ok: false, conflict: true })).toBe("Somebody changed the card while this was open. Nothing in Jira was changed.");
  });
});
