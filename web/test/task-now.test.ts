import { describe, expect, test } from "bun:test";
import { batonStep, taskNow } from "../src/lib/taskNow.ts";

describe("taskNow", () => {
  test("a todo card with no PR offers Start work", () => expect(taskNow({ status: "todo", pr: null })).toMatchObject({ word: "not started", action: "start", label: "Start work" }));
  test("an open PR is the one action", () => expect(taskNow({ status: "doing", pr: { number: 322, state: "OPEN" } }).action).toBe("open-pr"));
  test("a draft says so", () => expect(taskNow({ status: "doing", pr: { number: 322, state: "OPEN", draft: true } }).word).toBe("#322 is a draft"));
  test("a merged PR on an unfinished card offers Ready for QA", () => expect(taskNow({ status: "doing", pr: { number: 305, state: "merged" } }).label).toBe("Ready for QA"));
  test("blocked-by is its own line and never hides the PR's next step", () => {
    const n = taskNow({ status: "doing", pr: { number: 305, state: "OPEN" }, conflicts: true, blockedBy: "ORBIT-1012" });
    expect(n).toMatchObject({ word: "conflicts", action: "fix-conflicts", key: "conflicts", waiting: "waiting on ORBIT-1012" });
  });
  test("a blocked card with no PR offers nothing but still says what it waits on", () => expect(taskNow({ status: "todo", pr: null, blockedBy: "ORBIT-1012" })).toMatchObject({ action: "none", label: "", waiting: "waiting on ORBIT-1012" }));
  test("a started card with no PR has no line (mockup 07 draws none)", () => expect(taskNow({ status: "doing", pr: null })).toMatchObject({ word: "", action: "none", label: "" }));
  test("a card in QA says QA has it and offers Open", () => expect(taskNow({ status: "qa", pr: { number: 318, state: "MERGED" } })).toMatchObject({ word: "QA has it", action: "open-pr", label: "Open" }));
  test("only the key word is coloured", () => expect(taskNow({ status: "doing", pr: { number: 322, state: "OPEN" }, ci: { state: "failing", failed: 3 } }).key).toBe("3 failed"));
  test("the baton step: not started 1, PR open 2, QA 3", () => {
    expect([batonStep("start"), batonStep("review"), batonStep("open-pr"), batonStep("ready-for-qa")]).toEqual([1, 2, 2, 3]);
  });
  test("done has no line", () => expect(taskNow({ status: "done", pr: null }).action).toBe("none"));
});

describe("taskNow with the PR's rollup", () => {
  const pr = { number: 322, state: "OPEN" };
  test("failed checks say how many and offer Re-run N", () => expect(taskNow({ status: "doing", pr, ci: { state: "failing", failed: 3 } })).toMatchObject({ word: "3 failed on #322", action: "rerun", label: "Re-run 3" }));
  test("changes asked beats a running check", () => expect(taskNow({ status: "doing", pr, ci: { state: "running", failed: 0 }, review: "changes" }).word).toBe("changes asked on #322"));
  test("running checks are named", () => expect(taskNow({ status: "doing", pr, ci: { state: "running", failed: 0 } }).word).toBe("checks running on #322"));
  test("a PR waiting on review offers Review", () => expect(taskNow({ status: "doing", pr, ci: { state: "passing", failed: 0 }, review: "awaiting" })).toMatchObject({ word: "you review #322", action: "review", label: "Review" }));
  test("conflicts say so and offer Fix with agent, before failed checks", () => expect(taskNow({ status: "doing", pr, conflicts: true, ci: { state: "failing", failed: 3 } })).toMatchObject({ word: "conflicts", action: "fix-conflicts", label: "Fix with agent" }));
  test("no rollup keeps the plain line", () => expect(taskNow({ status: "doing", pr }).word).toBe("#322 open"));
});
