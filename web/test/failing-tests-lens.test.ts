/*
 * The "Failing tests" lens: what it says while it reads, what a refresh cost, and
 * what each verdict is allowed to claim. Decisions are functions; the screen is
 * asserted against its source.
 */
import { describe, expect, test } from "bun:test";
import type { FailingTestRow } from "../../shared/types.ts";
import { budgetLine, coverageLine, dateWords, matchesTest, maxRequests, readingLine, refreshLine, rowVerdict, verdictTone, VERDICT_NOTE } from "../src/lib/failingTests.ts";

const row = (o: Partial<FailingTestRow> = {}): FailingTestRow => ({ title: "orbit sync > gives its slot back", gist: "timeout after <t>", check: "build", runs: 9, prs: 4, firstSeen: 0, lastSeen: 0, verdict: { kind: "main" }, ...o });

describe("what it says while it reads", () => {
  test("the numbers are the ones it will act on", () => {
    expect(readingLine({ failedRuns: 6, readRuns: 4 }, 6)).toBe("Reading 6 failed runs · 4 already kept, 2 to fetch");
    expect(readingLine({ failedRuns: 41, readRuns: 4 }, 6)).toBe("Reading 41 failed runs · 4 already kept, 6 to fetch");
    expect(readingLine({ failedRuns: 1, readRuns: 1 }, 6)).toBe("Reading 1 failed run · 1 already kept, 0 to fetch");
  });
  test("the cost is said before it is spent: 2 requests a run plus the branch, run and jobs", () => {
    expect(maxRequests(6)).toBe(15);
    expect(budgetLine(6)).toBe("A refresh reads at most 6 failed runs: up to 15 GitHub requests, only when you press it.");
  });
});

describe("what a refresh did", () => {
  test("reads, what is left, what it cost, what main is", () => {
    expect(refreshLine({ read: 6, cap: 6, pending: 2, requests: 14, main: "red" })).toBe("Read 6 failed runs · 2 left for the next refresh · 14 requests · the newest push to the default branch is red");
    expect(refreshLine({ read: 0, cap: 6, pending: 0, requests: 1, main: "unknown" })).toBe("Nothing new to read · 1 request");
  });
  test("a stop says why, and keeps what it read", () => {
    expect(refreshLine({ read: 2, cap: 6, pending: 2, requests: 5, main: "unknown", error: "GitHub's hourly budget is used up" })).toContain("— stopped: GitHub's hourly budget is used up");
  });
  test("coverage is always stated: a short list is not a short history", () => {
    expect(coverageLine({ failedRuns: 41, readRuns: 35 })).toBe("Counted from 35 of 41 failed runs recorded in the last 90 days.");
    expect(coverageLine({ failedRuns: 0, readRuns: 0 })).toBe("No failed runs recorded in the last 90 days.");
  });
});

describe("rows", () => {
  test("verdict words say what was seen, never why", () => {
    expect(rowVerdict(row())).toBe("Red on main");
    expect(rowVerdict(row({ verdict: { kind: "flaky" } }))).toBe("Flaky test");
    expect(rowVerdict(row({ verdict: { kind: "prs", prs: 3 } }))).toBe("Failed on 3 PRs");
    expect(rowVerdict(row({ verdict: { kind: "this-pr", pr: 482 } }))).toBe("This PR only · #482");
    expect(rowVerdict(row({ verdict: { kind: "once" } }))).toBe("Seen once");
  });
  test("colour is a second signal, and a weak verdict is quiet", () => {
    expect(verdictTone({ kind: "main" })).toBe("bad");
    expect(verdictTone({ kind: "flaky" })).toBe("warn");
    expect(verdictTone({ kind: "once" })).toBe("quiet");
  });
  test("the footnote explains every verdict the table can show", () => {
    for (const w of ["Red on main", "Flaky test", "Failed on N PRs", "This PR only", "Seen once"]) expect(VERDICT_NOTE).toContain(w);
  });
  test("the filter looks at the name, the message, the check and the verdict", () => {
    expect(matchesTest(row(), "slot")).toBe(true);
    expect(matchesTest(row(), "TIMEOUT")).toBe(true);
    expect(matchesTest(row(), "red on main")).toBe(true);
    expect(matchesTest(row(), "lint")).toBe(false);
    expect(matchesTest(row(), "  ")).toBe(true);
  });
  test("dates", () => {
    const now = Date.parse("2026-10-01T12:00:00");
    expect(dateWords(Date.parse("2026-10-01T03:00:00"), now)).toBe("today");
    expect(dateWords(Date.parse("2026-09-26T03:00:00"), now)).toBe("Sep 26");
  });
});

const lens = await Bun.file(new URL("../src/components/prs/FailingTestsLens.tsx", import.meta.url)).text();
const metrics = await Bun.file(new URL("../src/components/prs/CiMetrics.tsx", import.meta.url)).text();
const code = (t: string) => t.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

describe("the screen, against its source", () => {
  test("the lens sits beside the other chips of the CI view, and the chip says how many", () => {
    expect(metrics).toContain("Failing tests");
    expect(metrics).toContain("<FailingTestsLens");
  });
  test("the table is read with every poll and costs nothing; GitHub is reached only by the refresh", () => {
    expect(metrics).toMatch(/usePoll\(active, \(\) => \{ load\(\); loadTests\(\); \}, 60_000\)/);
    expect(metrics).toMatch(/api\.prFailingTests\(root\)\n/);
    expect(metrics).toMatch(/api\.prFailingTests\(root, true\)/);
    // the one automatic refresh is the first look at the lens, once per repository, never a timer
    expect(metrics).toContain("refreshed.current.has(root)");
    expect(code(metrics)).not.toMatch(/setInterval\([^)]*refreshTests/);
  });
  test("no raw colour: house tokens only", () => {
    expect(code(lens)).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgb\(/);
    expect(lens).toContain("var(--surface-card)");
  });
  test("it shows the cost and the coverage on the page", () => {
    expect(lens).toContain("budgetLine(CAP)");
    expect(lens).toContain("coverageLine(data)");
  });
});
