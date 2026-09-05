/*
 * A SPENT SESSION IS NOT A VERDICT ON THE TASK.
 *
 * Run #136, measured: the whole of what the agent said was
 *
 *     You've hit your session limit · resets 6:40pm (Europe/Madrid)
 *
 * and the register answered "It finished having produced nothing — no commit,
 * and its own last words did not say why that was the right answer." They said
 * exactly why, and the cost of not reading it is not cosmetic: an `empty` run
 * counts as an ATTEMPT, and after enough attempts the register tells a person
 * that the task "has been started N times and has never finished. It needs a
 * person to look before it is worth trying again" — about a task nobody has
 * tried yet. That is the same shape as the four ENOENT rows, where a true
 * sentence about the wrong thing sent somebody to look at a binary.
 */
import { describe, expect, test } from "bun:test";
import { ranOutOfSession } from "../src/understudy-loop.ts";

describe("reading the agent's own last words", () => {
  test("the sentence it actually printed, with the time it named", () => {
    expect(ranOutOfSession("You've hit your session limit · resets 6:40pm (Europe/Madrid)"))
      .toBe("6:40pm (Europe/Madrid)");
  });

  test("the other ways it says the same thing", () => {
    expect(ranOutOfSession("Usage limit reached. Resets at 11am")).toBe("11am");
    expect(ranOutOfSession("You have reached your usage limit")).toBe("");
    /* A limit with no time is still a limit: "" and null mean different things,
       so callers test for `!== null` rather than for truthiness. */
    expect(ranOutOfSession("You've hit your session limit")).toBe("");
  });

  test("and it does not fire on work that merely mentions limits", () => {
    /* The agent narrates. A task about rate limits, a diff that contains the
       word, a test name — none of those are the agent saying it has stopped. */
    expect(ranOutOfSession("I added a rate limit to the sweep and reset the counter")).toBeNull();
    expect(ranOutOfSession("MAX_TAILS is the limit; the session resets on reconnect")).toBeNull();
    expect(ranOutOfSession("")).toBeNull();
  });
});

describe("what the loop does with it", () => {
  test("the row says it was never started, and the round ends there", async () => {
    const src = await Bun.file(new URL("../src/understudy-loop.ts", import.meta.url)).text();
    /* The verdict: `empty` with a sentence about the SESSION, not about the
       work — and the branch described as empty on purpose. */
    expect(src).toContain("the agent had no session left");
    expect(src).toContain("so this task was never started");
    /* And the loop stops rather than cutting another worktree: no agent on
       this machine can run until the reset, so the next round would produce
       another empty branch and another attempt counted against the task. */
    expect(src).toContain("if (/had no session left/.test(res.says))");
  });
});
