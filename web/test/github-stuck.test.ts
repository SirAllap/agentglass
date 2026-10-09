/*
 * Mergeability that never settles: when "a few seconds" stops being true, how
 * the panel says so, and how GitHub's public status page is read.
 */
import { describe, expect, test } from "bun:test";
import { stuckMinutes, STUCK_AFTER_MS, problemFromSummary, stuckDetail } from "../../shared/githubStatus.ts";
import { mergePath, type MergePathInput } from "../../shared/mergePath.ts";
import { mergeBlockers } from "../../shared/mergeBlockers.ts";
import { unknownSinceOf, forgetUnknown } from "../src/lib/unknownSince.ts";

const NOW = Date.parse("2026-10-09T13:04:00Z");
const MIN = 60_000;

describe("stuckMinutes thresholds", () => {
  test("not yet: under 3 min, and with no start at all", () => {
    expect(stuckMinutes(NOW - (STUCK_AFTER_MS - 1), NOW)).toBeNull();
    expect(stuckMinutes(null, NOW)).toBeNull();
    expect(stuckMinutes(undefined, NOW)).toBeNull();
  });
  test("exactly 3 min is stuck, and counts whole minutes", () => {
    expect(stuckMinutes(NOW - STUCK_AFTER_MS, NOW)).toBe(3);
    expect(stuckMinutes(NOW - 47 * MIN - 30_000, NOW)).toBe(47);
  });
  test("a start in the future (clock moved) is not stuck", () => {
    expect(stuckMinutes(NOW + MIN, NOW)).toBeNull();
  });
});

describe("unknownSince memory", () => {
  test("first sight is kept, a later read does not restart it, forgetting does", () => {
    const k = "acme/orbit#1042";
    expect(unknownSinceOf(k, 1000)).toBe(1000);
    expect(unknownSinceOf(k, 999_999)).toBe(1000);
    forgetUnknown(k);
    expect(unknownSinceOf(k, 5000)).toBe(5000);
    forgetUnknown(k);
  });
});

// The shape of https://www.githubstatus.com/api/v2/summary.json, trimmed.
const comp = (name: string, status: string) => ({ id: name, name, status });
const healthy = { components: [comp("Git Operations", "operational"), comp("API Requests", "operational"), comp("Pull Requests", "operational"), comp("Actions", "operational")], incidents: [] };

describe("problemFromSummary", () => {
  test("all operational, no incident: nothing to say", () => {
    expect(problemFromSummary(healthy)).toBeNull();
  });
  test("Pull Requests degraded: the pull-request sentence, linked to the status page", () => {
    const p = problemFromSummary({ ...healthy, components: [comp("Pull Requests", "degraded_performance")] });
    expect(p?.text).toBe("GitHub reports a problem with pull requests right now");
    expect(p?.url).toBe("https://www.githubstatus.com");
  });
  test("API Requests partial outage counts the same", () => {
    expect(problemFromSummary({ ...healthy, components: [comp("API Requests", "partial_outage")] })?.text).toContain("pull requests");
  });
  test("a component we do not watch being down is not our problem", () => {
    expect(problemFromSummary({ ...healthy, components: [comp("Actions", "major_outage"), comp("Pull Requests", "operational")] })).toBeNull();
  });
  test("an open incident is reported as an incident, by name", () => {
    const p = problemFromSummary({ ...healthy, incidents: [{ name: "Disruption with some GitHub services", status: "investigating" }] });
    expect(p?.text).toBe("GitHub reports an open incident: Disruption with some GitHub services");
  });
  test("a resolved incident is not open", () => {
    expect(problemFromSummary({ ...healthy, incidents: [{ name: "Old", status: "resolved" }] })).toBeNull();
  });
  test("not that shape: never a problem", () => {
    for (const bad of [null, undefined, "x", 3, [], {}, { components: "no" }, { components: [null, 4, { name: 1 }] }]) {
      expect(problemFromSummary(bad)).toBeNull();
    }
  });
});

describe("stuckDetail", () => {
  test("behind: names Update branch and github.com", () => {
    const s = stuckDetail(7, 3);
    expect(s).toContain("not decided for 7 min");
    expect(s).toContain("Update branch");
    expect(s).toContain("usually makes GitHub recompute");
    expect(s).toContain("github.com");
  });
  test("not behind: no Update branch advice", () => {
    expect(stuckDetail(7, 0)).not.toContain("Update branch");
    expect(stuckDetail(7, null)).toContain("github.com");
  });
  test("carries GitHub's own word when it has one", () => {
    expect(stuckDetail(7, 3, { text: "GitHub reports a problem with pull requests right now", url: "u" })).toContain("reports a problem with pull requests");
  });
});

const input = (over: Partial<MergePathInput> = {}): MergePathInput => ({
  state: "OPEN", mergeState: "UNKNOWN", mergeable: "UNKNOWN", reviewDecision: "APPROVED",
  humanReview: { kind: "approved", who: ["alice"] }, author: "bob", viewerDidAuthor: true,
  checksAll: [], baseRefName: "main", openThreads: 0, now: NOW, behind: 3, ...over,
});
const say = (i: MergePathInput) => mergePath(i).hero.parts.map((x) => x.text).join("");

describe("the merge path while UNKNOWN", () => {
  test("fresh: still the calm sentence", () => {
    const i = input({ unknownSince: NOW - 20_000 });
    expect(say(i)).toContain("still working out");
    expect(JSON.stringify(mergePath(i).rows)).not.toContain("has not decided");
  });
  test("stuck: how long, the options, and github.com as the action", () => {
    const i = input({ unknownSince: NOW - 12 * MIN });
    const p = mergePath(i);
    expect(say(i)).toContain("12 min");
    expect(p.hero.sub).toContain("usually makes GitHub recompute");
    expect(p.hero.primary?.id).toBe("open-github");
    expect(p.rows.some((r) => r.title === "GitHub has not decided for 12 min")).toBe(true);
  });
  test("stuck and GitHub reports trouble: the status page is a second action", () => {
    const p = mergePath(input({ unknownSince: NOW - 12 * MIN, githubProblem: { text: "GitHub reports a problem with pull requests right now", url: "https://www.githubstatus.com" } }));
    expect(p.hero.sub).toContain("reports a problem with pull requests");
    expect(p.hero.secondary).toMatchObject({ id: "open-log", url: "https://www.githubstatus.com" });
  });
  test("a settled pull request ignores an old start", () => {
    const i = input({ mergeState: "CLEAN", mergeable: "MERGEABLE", unknownSince: NOW - 12 * MIN, checksAll: [] });
    expect(JSON.stringify(mergePath(i))).not.toContain("has not decided");
  });
  test("the blocker row, not just the hero", () => {
    const row = mergeBlockers({ state: "OPEN", mergeState: "UNKNOWN", baseRefName: "main", behind: 3, stuckMin: 9 } as never).find((b) => b.kind === "computing");
    expect(row?.title).toBe("GitHub has not decided for 9 min");
  });
});

describe("lagging pull request (branch ref moved, PR head did not)", () => {
  test("strong signal: says so at once, without waiting for the 3 minutes", () => {
    const i = input({ unknownSince: NOW - 10_000, prLagging: true });
    const p = mergePath(i);
    expect(say(i)).toContain("has not caught up with its branch");
    expect(p.hero.sub).toContain("GitHub updated the branch but the pull request has not caught up yet");
    expect(p.rows.some((r) => r.title === "The pull request has not caught up with its branch")).toBe(true);
  });
  test("not lagging and fresh: the calm sentence", () => {
    expect(say(input({ unknownSince: NOW - 10_000 }))).toContain("still working out");
  });
});
