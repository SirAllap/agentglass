/*
 * A merged or closed pull request never changes, so what its card shows is read
 * once and kept. These pin the facts read off a GraphQL node, and the request
 * budget: one batched read cold (a second only when something ended red), none
 * warm, none for a row already stored, and nothing stored for an open one.
 * The GraphQL answer is a fixture shaped like the real node, with invented names.
 */
import { describe, expect, test } from "bun:test";
import { prRowDetails, isBotLogin, type RowDetailsIo } from "../src/prs.ts";
import { closedFactsFromNode, failingNames, lastHumanRemark, mergeMethod, reviewFacts } from "../src/prClosedFacts.ts";
import { readClosed } from "../src/prClosedStore.ts";

const counts = (ok: number, red = 0, skipped = 0) => [
  { state: "SUCCESS", count: ok }, { state: "FAILURE", count: red }, { state: "SKIPPED", count: skipped },
];

const node = (over: Record<string, unknown> = {}) => ({
  number: 7, title: "ORBIT-1042 thing", headRefName: "ORBIT-1042-thing",
  state: "MERGED", createdAt: "2026-01-01T10:00:00Z", mergedAt: "2026-01-03T13:00:00Z", closedAt: "2026-01-03T13:00:00Z",
  mergedBy: { login: "ada" }, closer: { nodes: [] },
  mergeCommit: { messageHeadline: "ORBIT-1042 thing (#7)", parents: { totalCount: 1 } },
  additions: 271, deletions: 64, changedFiles: 11, reviewDecision: "APPROVED", mergeable: "UNKNOWN",
  author: { login: "grace" }, reviewRequests: { nodes: [] },
  commits: { nodes: [{ commit: { oid: "abc123", committedDate: "2026-01-03T12:00:00Z",
    statusCheckRollup: { state: "SUCCESS", contexts: { checkRunCountsByState: counts(74, 0, 1), statusContextCountsByState: [] } } } }] },
  commitTotal: { totalCount: 3 }, issueComments: { totalCount: 4 },
  lastRemarks: { nodes: [{ body: "superseded by #9", author: { login: "ada" } }] },
  threadSizes: { nodes: [{ comments: { totalCount: 5 } }] },
  comments: { nodes: [] }, reviewThreads: { totalCount: 1, nodes: [{ isResolved: true }] },
  reviews: { nodes: [
    { submittedAt: "2026-01-02T10:00:00Z", state: "CHANGES_REQUESTED", author: { login: "ada" } },
    { submittedAt: "2026-01-03T10:00:00Z", state: "APPROVED", author: { login: "ada" } },
    { submittedAt: "2026-01-03T11:00:00Z", state: "APPROVED", author: { login: "bot-reviewer" } },
  ] },
  ...over,
});

describe("the facts of how it ended", () => {
  test("merge method is read off the merge commit", () => {
    expect(mergeMethod(node())).toBe("squash");
    expect(mergeMethod(node({ mergeCommit: { messageHeadline: "Merge pull request #7", parents: { totalCount: 2 } } }))).toBe("merge");
    expect(mergeMethod(node({ mergeCommit: { messageHeadline: "ORBIT-1042 last commit", parents: { totalCount: 1 } } }))).toBe("rebase");
    expect(mergeMethod(node({ mergeCommit: null }))).toBeNull();
    expect(mergeMethod(node({ state: "CLOSED", mergedAt: null }))).toBeNull();
  });
  test("each person's last verdict stands, rounds and comments are counted", () => {
    const r = reviewFacts(node());
    expect(r.approved.sort()).toEqual(["ada", "bot-reviewer"]);
    expect(r.changes).toEqual([]);
    expect(r.rounds).toBe(3);
    expect(r.comments).toBe(9);
  });
  test("a dismissed verdict is no verdict", () => {
    const r = reviewFacts(node({ reviews: { nodes: [
      { submittedAt: "2026-01-02T10:00:00Z", state: "CHANGES_REQUESTED", author: { login: "ada" } },
      { submittedAt: "2026-01-02T11:00:00Z", state: "DISMISSED", author: { login: "ada" } },
    ] } }));
    expect(r.changes).toEqual([]);
  });
  test("merged: who merged, how, final counts; no why", () => {
    const f = closedFactsFromNode(node(), { total: 75, success: 74, failure: 0, skipped: 1 }, [], isBotLogin)!;
    expect([f.by, f.method, f.commits, f.why]).toEqual(["ada", "squash", 3, null]);
    expect(f.checks).toEqual({ total: 75, success: 74, failure: 0, skipped: 1, failing: [] });
  });
  test("closed without merging: the closer, and the last human comment as the why", () => {
    const n = node({ state: "CLOSED", mergedAt: null, mergedBy: null, mergeCommit: null,
      closer: { nodes: [{ actor: { login: "grace" } }] },
      lastRemarks: { nodes: [{ body: "superseded by #9", author: { login: "ada" } }, { body: "LGTM", author: { login: "review-bot[bot]" } }] } });
    const f = closedFactsFromNode(n, { total: 4, success: 1, failure: 3, skipped: 0 }, ["build", "lint", "types"], isBotLogin)!;
    expect([f.by, f.method, f.why]).toEqual(["grace", null, "superseded by #9"]);
    expect(f.checks.failing).toEqual(["build", "lint"]);
  });
  test("an open node has no closed facts", () => {
    expect(closedFactsFromNode(node({ state: "OPEN" }), { total: 1, success: 1, failure: 0, skipped: 0 }, [], isBotLogin)).toBeNull();
  });
  test("red check names: check runs and status contexts, two at most", () => {
    const n = { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "ok", conclusion: "SUCCESS" },
      { __typename: "CheckRun", name: "build", conclusion: "FAILURE" },
      { __typename: "StatusContext", context: "ci/legacy", state: "ERROR" },
      { __typename: "CheckRun", name: "lint", conclusion: "TIMED_OUT" },
    ] } } } }] } };
    expect(failingNames(n)).toEqual(["build", "ci/legacy"]);
  });
  test("a bot-only conversation has no why", () => {
    expect(lastHumanRemark({ lastRemarks: { nodes: [{ body: "x", author: { login: "review-bot[bot]" } }] } }, isBotLogin)).toBeNull();
  });
});

/** An io whose GitHub is a counter, answering the nodes it is given. */
function fakeIo(nodes: Record<number, any>, names: Record<number, any> = {}) {
  const calls: string[] = [];
  const io: RowDetailsIo = {
    repo: async () => ({ key: `github.com/acme/orbit-${calls.length >= 0 ? tag : ""}`, host: "github.com", owner: "acme", name: "orbit", nameWithOwner: "acme/orbit" }),
    graphql: async (q) => {
      calls.push(q);
      const data: Record<string, unknown> = {};
      for (const m of q.matchAll(/p(\d+): pullRequest/g)) data[`p${m[1]}`] = q.includes("statusCheckRollup{contexts") ? names[Number(m[1])] : nodes[Number(m[1])];
      return { data: { repository: data } };
    },
    me: async () => "grace",
  };
  return { io, calls };
}
let tag = "a";

describe("the request budget", () => {
  test("cold: one batched read for the finished page, then none for the same numbers", async () => {
    tag = `cold-${Date.now()}`;
    const { io, calls } = fakeIo({ 7: node({ number: 7 }), 8: node({ number: 8, mergeCommit: { messageHeadline: "x (#8)", parents: { totalCount: 1 } } }) });
    const first = await prRowDetails("/x", "7,8", "7,8", io);
    expect(calls.length).toBe(1);
    expect(first.rows[7]!.closed!.by).toBe("ada");
    expect(first.rows[7]!.checks!.success).toBe(74);
    const again = await prRowDetails("/x", "7,8", "7,8", io);
    expect(calls.length).toBe(1);
    expect(again.rows[7]!.closed).toEqual(first.rows[7]!.closed);
    expect(again.rows[8]!.additions).toBe(271);
  });
  test("what is stored survives the in-memory cache: the table holds it", async () => {
    tag = `table-${Date.now()}`;
    const { io } = fakeIo({ 7: node() });
    await prRowDetails("/x", "7", "7", io);
    const kept = readClosed(`github.com/acme/orbit-${tag}`, [7]).get(7)!;
    expect(kept.row.closed!.method).toBe("squash");
    expect(kept.head).toBe("ORBIT-1042-thing");
    expect("card" in kept.row).toBe(false);
  });
  test("a finished page that ended red costs a second, small read for the names", async () => {
    tag = `red-${Date.now()}`;
    const red = node({ state: "CLOSED", mergedAt: null, mergeCommit: null,
      commits: { nodes: [{ commit: { oid: "d", committedDate: "2026-01-03T12:00:00Z",
        statusCheckRollup: { state: "FAILURE", contexts: { checkRunCountsByState: counts(1, 2), statusContextCountsByState: [] } } } }] } });
    const names = { 7: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { __typename: "CheckRun", name: "build", conclusion: "FAILURE" }, { __typename: "CheckRun", name: "lint", conclusion: "FAILURE" }] } } } }] } } };
    const { io, calls } = fakeIo({ 7: red }, names);
    const out = await prRowDetails("/x", "7", "7", io);
    expect(calls.length).toBe(2);
    expect(out.rows[7]!.closed!.checks.failing).toEqual(["build", "lint"]);
    await prRowDetails("/x", "7", "7", io);
    expect(calls.length).toBe(2);
  });
  test("a row claimed finished that is open is answered, and nothing is stored for it", async () => {
    tag = `open-${Date.now()}`;
    const { io } = fakeIo({ 7: node({ state: "OPEN", mergedAt: null, mergeCommit: null }) });
    const out = await prRowDetails("/x", "7", "7", io);
    expect(out.rows[7]!.checksLoaded).toBe(true);
    expect(out.rows[7]!.closed).toBeUndefined();
    expect(readClosed(`github.com/acme/orbit-${tag}`, [7]).size).toBe(0);
  });
  test("a partial answer (reviews missing) is not stored as final", async () => {
    tag = `partial-${Date.now()}`;
    const { io } = fakeIo({ 7: node({ reviews: null }) });
    const out = await prRowDetails("/x", "7", "7", io);
    expect(out.rows[7]!.closed).toBeUndefined();
    expect(readClosed(`github.com/acme/orbit-${tag}`, [7]).size).toBe(0);
  });
});
