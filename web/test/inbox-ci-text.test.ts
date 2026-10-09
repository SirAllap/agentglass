/*
 * The line under a failed CI row in the Inbox: the failing part, from what the
 * app already read, never from a new request.
 */
import { describe, expect, test } from "bun:test";
import type { CheckFailureSummary, PrCheck } from "../../shared/types.ts";
import { inboxCiLine as line, parseSuiteTitle } from "../src/lib/inboxCiText.ts";

const suite = (title: string) => ({ type: "CheckSuite", title });
const check = (name: string, workflow = "CI"): PrCheck => ({ name, workflow, state: "failure", done: true, url: `https://github.com/acme/orbit/actions/runs/9/job/${name.length}${workflow.length}` } as PrCheck);
const pr = (branch: string, failing: PrCheck[]) => ({ headRefName: branch, checks: { failing } as never });
const read = (titles: string[], more = 0): CheckFailureSummary => ({ state: "read", source: "log", count: titles.length, more, titles, verdicts: titles.map(() => ({ kind: "unknown" }) as never) });
const none = () => undefined;
/** The line as it reads on screen: the cut-able part, then the part that is never cut. */
const inboxCiLine = (...a: Parameters<typeof line>) => { const l = line(...a); return l && l.text + l.tail; };

describe("parseSuiteTitle", () => {
  test("names the workflow and the branch, with or without an attempt", () => {
    expect(parseSuiteTitle("CI / Tests workflow run failed for feat/orbit-1042 branch")).toEqual({ workflow: "CI / Tests", branch: "feat/orbit-1042" });
    expect(parseSuiteTitle("CI workflow run, Attempt #2 failed for main branch")).toEqual({ workflow: "CI", branch: "main" });
  });
  test("passed, cancelled and pending runs are not parsed", () => {
    expect(parseSuiteTitle("CI workflow run cancelled for main branch")).toBeNull();
    expect(parseSuiteTitle("CI workflow run succeeded for main branch")).toBeNull();
    expect(parseSuiteTitle("Add a thing")).toBeNull();
  });
});

describe("inboxCiLine", () => {
  const failed = suite("CI workflow run failed for feat/thing branch");

  test("failed with an extracted test: its name", () => {
    expect(inboxCiLine(failed, [pr("feat/thing", [check("Tests")])], () => read(["adds two numbers"]))).toBe("adds two numbers");
  });
  test("many failures: the first, and how many more", () => {
    expect(inboxCiLine(failed, [pr("feat/thing", [check("Tests")])], () => read(["a", "b"], 3))).toBe("a +4 more");
  });
  test("failed with nothing read: the failing checks, by name", () => {
    expect(inboxCiLine(failed, [pr("feat/thing", [check("Tests")])], none)).toBe("Tests failing");
    expect(inboxCiLine(failed, [pr("feat/thing", [check("Tests"), check("Lint"), check("Types")])], none)).toBe("Tests, Lint +1 more failing");
  });
  test("the count is a piece of its own, so a narrow row cuts the name and keeps the count", () => {
    expect(line(failed, [pr("feat/thing", [check("Tests")])], () => read(["a", "b"], 3))).toEqual({ text: "a", tail: " +4 more" });
    expect(line(failed, [pr("feat/thing", [check("Tests")])], none)).toEqual({ text: "Tests", tail: " failing" });
  });
  test("only the workflow the notification names, when any of its checks failed", () => {
    const ci = check("Tests", "CI"), other = check("Lint", "Docs");
    expect(inboxCiLine(failed, [pr("feat/thing", [other, ci])], none)).toBe("Tests failing");
    expect(inboxCiLine(suite("Release workflow run failed for feat/thing branch"), [pr("feat/thing", [other, ci])], none)).toBe("Lint, Tests failing");
  });
  test("unchanged: not a suite, not a failure, no loaded PR, nothing failing now", () => {
    const prs = [pr("feat/thing", [check("Tests")])];
    expect(inboxCiLine({ type: "PullRequest", title: failed.title }, prs, none)).toBeNull();
    expect(inboxCiLine(suite("CI workflow run cancelled for feat/thing branch"), prs, none)).toBeNull();
    expect(inboxCiLine(failed, [pr("feat/other", [check("Tests")])], none)).toBeNull();
    expect(inboxCiLine(failed, [pr("feat/thing", [])], none)).toBeNull();
  });
});
