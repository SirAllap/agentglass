/*
 * Which controls on this phone hold, and what letting go early means.
 *
 * The gate rule is the anti-regex decision: a phone must not carry a word list
 * that decides whether a command is dangerous. Every Allow holds, whatever the
 * command says — the server treats release as the dangerous half, so the phone
 * holds the release. Deny is the safe direction and stays one tap.
 *
 * There is no renderer here, so the gesture is a pure settlement: how long the
 * finger was down, and whether that was enough.
 */
import { describe, expect, test } from "bun:test";
import { HOLD_MS, holdsToConfirm, settle } from "../src/model/confirmPolicy.ts";

describe("which actions hold", () => {
  test("every allow on a gate, whatever the command says", () => {
    // Nothing here reads the command text: `ls` and `rm -rf .next` are one
    // action, because the phone is not the thing that judges them.
    expect(holdsToConfirm("gate.allow")).toBe(true);
  });

  test("deny on a gate is a tap, because the safe direction must not be slow", () => {
    expect(holdsToConfirm("gate.deny")).toBe(false);
  });

  test("the destructive writes hold and the reversible ones do not", () => {
    const holds = [
      "pr.merge", "pr.close", "pr.reopen", "pr.branch.update",
      "jira.done", "plan.go",
      // Closing a window stops what runs in it, so it holds like the other
      // writes: the window sheet draws it with the same HoldButton.
      "window.kill",
    ] as const;
    const taps = [
      "pr.rerun", "pr.labels", "pr.reviewers", "pr.draft", "pr.edit",
      "jira.move", "jira.comment", "jira.assign", "jira.link",
      "plan.nogo", "settings.answer",
    ] as const;
    for (const action of holds) expect([action, holdsToConfirm(action)]).toEqual([action, true]);
    for (const action of taps) expect([action, holdsToConfirm(action)]).toEqual([action, false]);
  });
});

describe("a released hold", () => {
  test("decides nothing, and says so", () => {
    const released = settle("gate.allow", 800);
    expect(released.decided).toBe(false);
    expect(released.said).toBe("Nothing was sent.");
  });

  test("completes at 1.4 s, and not a millisecond before", () => {
    expect(HOLD_MS).toBe(1400);
    expect(settle("gate.allow", HOLD_MS).decided).toBe(true);
    expect(settle("gate.allow", HOLD_MS - 1).decided).toBe(false);
  });

  test("a tap action is decided whenever the finger lifts", () => {
    expect(settle("gate.deny", 0).decided).toBe(true);
    expect(settle("gate.deny", 30).decided).toBe(true);
  });
});
