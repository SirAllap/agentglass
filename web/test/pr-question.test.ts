import { describe, expect, test } from "bun:test";
import { FOLD_BELOW_PX, canNudge, jewelFraction, nowSentence, optionalFailedCount, rerunLabel, rowTag, foldedLine, onlyChecksAndReviewBlock, questionFolded, questionVerdict, questionWord, requiredChecksOpen, verdictWhy } from "../src/lib/prQuestion.ts";

const ok = { tone: "ok" as const };
const warn = { tone: "warn" as const };

describe("questionWord", () => {
  test("ready is Yes", () => expect(questionWord({ state: "OPEN", verdict: ok, conflicted: false })).toBe("Yes"));
  test("blocked is Not yet", () => expect(questionWord({ state: "OPEN", verdict: warn, conflicted: false })).toBe("Not yet"));
  test("a conflict is No, even if checks are green", () => expect(questionWord({ state: "OPEN", verdict: ok, conflicted: true })).toBe("No"));
  test("merged and closed ignore the verdict", () => {
    expect(questionWord({ state: "MERGED", verdict: warn, conflicted: true })).toBe("Merged");
    expect(questionWord({ state: "CLOSED", verdict: ok, conflicted: false })).toBe("Closed");
  });
});

test("questionVerdict swaps only the lead", () => {
  const v = questionVerdict({ tone: "bad", lead: "Merging is blocked.", text: "3 checks failed." }, "Not yet");
  expect(v).toEqual({ tone: "bad", lead: "Not yet.", text: "3 checks failed." });
});

describe("questionFolded", () => {
  test("folds under the limit", () => expect(questionFolded(FOLD_BELOW_PX - 1, false)).toBe(true));
  test("stays open at the limit", () => expect(questionFolded(FOLD_BELOW_PX, false)).toBe(false));
  test("Show keeps it open", () => expect(questionFolded(400, true)).toBe(false));
  test("an unknown height (0) never folds", () => expect(questionFolded(0, false)).toBe(false));
});

describe("foldedLine", () => {
  test("word then up to two reasons", () =>
    expect(foldedLine("Not yet", ["3 checks failed.", "ana not looked", "third"])).toBe("Not yet · 3 checks failed · ana not looked"));
  test("no reasons is the word alone", () => expect(foldedLine("Yes", [])).toBe("Yes"));
});

import { nowBar } from "../src/lib/prQuestion.ts";
describe("nowBar", () => {
  test("counts the run and names the slowest unfinished job's usual time", () => {
    const b = nowBar([
      { name: "lint", state: "success", done: true },
      { name: "e2e", state: "pending", done: false, usual: { median: 360_000, n: 9 } },
      { name: "unit", state: "pending", done: false, usual: { median: 60_000, n: 9 } },
      { name: "build", state: "failure", done: true },
    ]);
    expect(b).toEqual({ green: 1, running: 2, failed: 1, total: 4, usual: "e2e usually 6 min" });
  });
  test("skipped and neutral count as green, so a finished run fills the bar", () => {
    const b = nowBar([
      { name: "lint", state: "success", done: true },
      { name: "docs", state: "skipped", done: true },
      { name: "lic", state: "neutral", done: true },
    ]);
    expect(b).toMatchObject({ green: 3, running: 0, failed: 0, total: 3 });
  });
  test("nothing reported, no bar; too few samples, no usual", () => {
    expect(nowBar([])).toBeNull();
    expect(nowBar([{ name: "e2e", state: "pending", done: false, usual: { median: 360_000, n: 2 } }])?.usual).toBeNull();
  });
});

describe("canNudge", () => {
  const who = { login: "ana" };
  test("a person who must review is nudgeable, whether reviewer or team", () => {
    expect(canNudge({ kind: "review-required", mover: "reviewer", person: who })).toBe(true);
    expect(canNudge({ kind: "review-required", mover: "team", person: who })).toBe(true);
  });
  test("not when it waits on CI, on me, or nobody is named", () => {
    expect(canNudge({ kind: "review-required", mover: "wait", person: who })).toBe(false);
    expect(canNudge({ kind: "review-required", mover: "you", person: who })).toBe(false);
    expect(canNudge({ kind: "review-required", mover: "reviewer" })).toBe(false);
    expect(canNudge({ kind: "check-failing", mover: "reviewer", person: who })).toBe(false);
  });
});

describe("requiredChecksOpen", () => {
  test("optional failures and runs do not count", () => {
    expect(requiredChecksOpen([{ required: false, done: true, state: "failure" }, { required: false, done: false, state: "pending" }])).toBe(false);
  });
  test("a required one failing or running counts; a green or skipped one does not", () => {
    expect(requiredChecksOpen([{ required: true, done: false, state: "pending" }])).toBe(true);
    expect(requiredChecksOpen([{ required: true, done: true, state: "failure" }])).toBe(true);
    expect(requiredChecksOpen([{ required: true, done: true, state: "success" }, { required: true, done: true, state: "skipped" }])).toBe(false);
  });
});

describe("onlyChecksAndReviewBlock", () => {
  test("checks and review rows only", () => {
    expect(onlyChecksAndReviewBlock(["check-failing", "review-required", "note", "approved"])).toBe(true);
  });
  test("any other blocker says no", () => {
    expect(onlyChecksAndReviewBlock(["check-failing", "threads"])).toBe(false);
    expect(onlyChecksAndReviewBlock(["review-required", "behind"])).toBe(false);
  });
});

describe("verdictWhy", () => {
  test("is the hero words", () => expect(verdictWhy("ana has not looked yet")).toBe("ana has not looked yet"));
  test("with no hero words it is empty: the dock line is never copied into the verdict", () => expect(verdictWhy("")).toBe(""));
});

describe("jewel and row tags (mockup 05)", () => {
  test("the arc is the share of stages done", () => {
    expect(jewelFraction([{ status: "done" }, { status: "blocked" }, { status: "done" }, { status: "idle" }])).toBe(0.5);
    expect(jewelFraction([])).toBe(0);
  });
  test("BLOCKS when a person acts, WAITS when time or an asked person is missing, nothing for fyi and done", () => {
    expect(rowTag("you")).toBe("BLOCKS");
    expect(rowTag("ci")).toBe("WAITS");
    expect(rowTag("reviewer")).toBe("WAITS");
    expect(rowTag("fyi")).toBeNull();
    expect(rowTag("done")).toBeNull();
  });
});

test("rerunLabel counts distinct failed workflow runs, as the server reruns them", () => {
  const c = (url: string, state: string, required = true, done = true) => ({ url, required, state, done });
  const run = (id: number, job = 1) => `https://github.com/o/r/actions/runs/${id}/job/${job}`;
  // two failed jobs of one run, one failed optional run, a failure with no run url, a success
  expect(rerunLabel([c(run(1, 1), "failure"), c(run(1, 2), "failure"), c(run(2, 1), "failure", false), c("https://ci.example/x", "failure"), c(run(3), "success")])).toBe("Re-run 2 failed");
  expect(rerunLabel([c("https://ci.example/x", "failure"), c(run(3), "success")])).toBe("Re-run failed");
});

test("optionalFailedCount counts failed finished checks that are not required", () => {
  const c = (required: boolean, state: string, done = true) => ({ required, state, done });
  expect(optionalFailedCount([c(false, "failure"), c(false, "failure"), c(true, "failure"), c(false, "success"), c(false, "failure", false)])).toBe(2);
  expect(optionalFailedCount([c(true, "failure")])).toBe(0);
});

test("nowSentence: approved ago for Yes, short sha on base for Merged, nothing otherwise", () => {
  const now = Date.parse("2026-01-01T12:00:00Z");
  expect(nowSentence({ word: "Yes", approvedAt: "2026-01-01T11:46:00Z", base: "main", now })).toBe("approved 14 min ago");
  expect(nowSentence({ word: "Merged", mergeSha: "a1b2c3d", base: "main", now })).toBe("a1b2c3d on main");
  expect(nowSentence({ word: "Merged", base: "main", now })).toBeNull();
  expect(nowSentence({ word: "Not yet", approvedAt: "2026-01-01T11:46:00Z", base: "main", now })).toBeNull();
});
