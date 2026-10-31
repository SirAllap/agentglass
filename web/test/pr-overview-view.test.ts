import { describe, expect, test } from "bun:test";
import { overviewRows, overviewVerdict, type OverviewFacts } from "../src/lib/prOverviewView.ts";

const base = (over: Partial<OverviewFacts> = {}): OverviewFacts => ({
  checks: { success: 12, failure: 0, pending: 0, skipped: 0, total: 12 },
  reviewers: [{ login: "mara-k", state: "approved" }, { login: "theo-w", state: "approved" }],
  conflicted: false, head: "orbit-1042-retry-budget", base: "main", behind: 0, ...over,
});
const row = (f: OverviewFacts, k: string) => overviewRows(f).find((r) => r.key === k)!;

describe("overviewRows: the mockup's four rows, in its order and words", () => {
  test("order and a ready frame", () => {
    const rows = overviewRows(base());
    expect(rows.map((r) => r.key)).toEqual(["checks", "review", "conflicts", "branch"]);
    expect(rows.map((r) => r.text)).toEqual(["12 of 12 passing", "mara-k approved, theo-w approved", "No conflicts with main", "Up to date with main"]);
    expect(rows.every((r) => r.tone === "ok")).toBe(true);
  });
  test("checks: failing is red and offers a rerun, running is amber, none reported is not green when they are about to start", () => {
    const f = row(base({ checks: { success: 9, failure: 3, pending: 0, skipped: 0, total: 12 } }), "checks");
    expect(f).toMatchObject({ tone: "bad", text: "3 failing, 9 passing", rerun: true });
    expect(row(base({ checks: { success: 9, failure: 0, pending: 3, skipped: 0, total: 12 } }), "checks")).toMatchObject({ tone: "warn", text: "3 still running" });
    expect(row(base({ checks: { success: 0, failure: 0, pending: 0, skipped: 0, total: 0 }, awaitingChecks: true }), "checks").tone).toBe("warn");
    expect(row(base({ checks: { success: 10, failure: 0, pending: 0, skipped: 2, total: 12 } }), "checks").text).toBe("10 of 10 passing · 2 skipped");
  });
  test("review: changes requested is red, nobody asked is amber, bots and teams are not read out", () => {
    expect(row(base({ reviewers: [{ login: "mara-k", state: "changes" }] }), "review")).toMatchObject({ tone: "bad", text: "mara-k asked for changes" });
    expect(row(base({ reviewers: [] }), "review")).toMatchObject({ tone: "warn", text: "Nobody has been asked yet" });
    expect(row(base({ reviewers: [{ login: "ci-bot", state: "approved", isBot: true }, { login: "core", state: "awaiting", isTeam: true }] }), "review").text).toBe("Nobody has been asked yet");
    expect(row(base({ reviewers: [{ login: "mara-k", state: "awaiting", again: true }] }), "review").text).toBe("mara-k was asked to look again");
  });
  test("conflicts and branch", () => {
    expect(row(base({ conflicted: true, conflictFiles: 2 }), "conflicts")).toMatchObject({ tone: "bad", text: "orbit-1042-retry-budget conflicts with main in 2 files" });
    expect(row(base({ behind: 3 }), "branch")).toMatchObject({ tone: "warn", text: "3 commits behind main" });
    expect(row(base({ behind: 1 }), "branch").text).toBe("1 commit behind main");
    expect(row(base({ behind: null, behindMoved: true }), "branch")).toMatchObject({ tone: "warn", text: "main has moved on" });
  });
  test("each row says where its button goes", () => {
    expect(row(base(), "checks").go).toBe("checks");
    expect(row(base(), "review").go).toBe("conversation");
    expect(row(base(), "conflicts").go).toBeUndefined();
  });
});

describe("overviewVerdict", () => {
  const v = { ready: true, why: "", conflicted: false, checksFailing: 0, approvedBy: ["mara-k", "theo-w"], checksPassed: 12 };
  test("ready names who approved and how many checks are green", () =>
    expect(overviewVerdict(v)).toEqual({ tone: "ok", lead: "Ready to land.", text: "Approved by mara-k and theo-w, 12 checks green, no conflicts." }));
  test("blocked says the dock's own words, red for conflicts or failing checks, amber for waiting", () => {
    expect(overviewVerdict({ ...v, ready: false, why: "2 checks failing", checksFailing: 2 })).toEqual({ tone: "bad", lead: "Merging is blocked.", text: "2 checks failing." });
    expect(overviewVerdict({ ...v, ready: false, why: "Conflicts with main", conflicted: true }).text).toBe("Conflicts with main. Resolve it here or hand it to a terminal.");
    expect(overviewVerdict({ ...v, ready: false, why: "Waiting on mara-k." }).tone).toBe("warn");
  });
});
