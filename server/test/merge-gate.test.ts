// What the base branch demands, read from GATE_QUERY's answer.
//
// The fixtures are the shapes GitHub actually returns, and the one that
// matters most is the writer's: classic branch protection comes back null to
// anybody who is not an admin, even on a branch that has it. Measured on a
// base locked for a deploy — the rule was null, the rulesets were empty and
// `refUpdateRule.viewerCanPush` was true, while GitHub's own page said the
// branch was locked. So "the lock is off" must never be read out of a null.
import { describe, expect, test } from "bun:test";
import { mergeGateOf, requiredCheckKeys, checkKey, GATE_QUERY, DETAIL_QUERY } from "../src/prs.ts";

const src = await Bun.file(new URL("../src/prs.ts", import.meta.url)).text();

const repo = (pr: any, extra: any = {}) => ({ viewerPermission: "WRITE", ...extra, pullRequest: pr });
const pr = (baseRef: any, extra: any = {}) => ({
  viewerCanMergeAsAdmin: false, isMergeQueueEnabled: false, isInMergeQueue: false, baseRef, ...extra,
});
const writerView = {
  branchProtectionRule: null,
  refUpdateRule: {
    requiredApprovingReviewCount: 1, requiresCodeOwnerReviews: false,
    requiresConversationResolution: false, requiresSignatures: false, viewerCanPush: true,
    requiredStatusCheckContexts: ["build", "lint"],
  },
  rules: { nodes: [] },
};

describe("the merge gate", () => {
  test("a writer who cannot read branch protection gets null, not false, for what lives only there", () => {
    const g = mergeGateOf(repo(pr(writerView)))!;
    expect(g.protectionVisible).toBe(false);
    expect(g.locked).toBeNull();
    expect(g.dismissStale).toBeNull();
    expect(g.upToDate).toBeNull();
    expect(g.approvals).toBe(1);
    expect(g.viewerCanPush).toBe(true);
    expect(g.permission).toBe("WRITE");
    // What a writer CAN read: the required contexts, off refUpdateRule.
    expect(g.requiredContexts).toEqual(["build", "lint"]);
  });

  test("to an admin a null rule means there is none, not that it is hidden", () => {
    // Measured on a repository protected only by a ruleset: the admin's
    // branchProtectionRule and refUpdateRule both came back null.
    const g = mergeGateOf(repo(pr({ branchProtectionRule: null, refUpdateRule: null, rules: { nodes: [] } }),
      { viewerPermission: "ADMIN" }))!;
    expect(g.protectionVisible).toBe(true);
    expect(g.locked).toBe(false);
    expect(g.dismissStale).toBe(false);
    expect(g.upToDate).toBe(false);
  });

  test("an admin reads the lock off classic protection", () => {
    const g = mergeGateOf(repo(pr({
      branchProtectionRule: {
        lockBranch: true, requiresApprovingReviews: true, requiredApprovingReviewCount: 2,
        dismissesStaleReviews: false, requireLastPushApproval: true, requiresCodeOwnerReviews: false,
        requiresStrictStatusChecks: true, requiresConversationResolution: true,
        requiresCommitSignatures: false, requiresDeployments: true, requiredDeploymentEnvironments: ["staging"],
      },
      refUpdateRule: null, rules: { nodes: [] },
    }, { viewerCanMergeAsAdmin: true }), { viewerPermission: "ADMIN" }))!;
    expect(g.protectionVisible).toBe(true);
    expect(g.locked).toBe(true);
    expect(g.lockedBy).toBe("branch protection");
    expect(g.canBypass).toBe(true);
    expect(g.approvals).toBe(2);
    expect(g.lastPushApproval).toBe(true);
    expect(g.dismissStale).toBe(false);
    expect(g.upToDate).toBe(true);
    expect(g.conversationResolution).toBe(true);
    expect(g.deployments).toEqual(["staging"]);
  });

  test("readable protection without a lock says false, so the panel can say so", () => {
    const g = mergeGateOf(repo(pr({
      branchProtectionRule: { lockBranch: false, requiresApprovingReviews: false },
      refUpdateRule: null, rules: { nodes: [] },
    })))!;
    expect(g.locked).toBe(false);
  });

  test("a ruleset lock is visible to anybody who can read the repository, and carries its name", () => {
    for (const type of ["LOCK_BRANCH", "UPDATE"]) {
      const g = mergeGateOf(repo(pr({
        ...writerView,
        rules: { nodes: [{ type, repositoryRuleset: { name: "release freeze", enforcement: "ACTIVE" }, parameters: null }] },
      })))!;
      expect(g.locked).toBe(true);
      expect(g.lockedBy).toBe("release freeze");
    }
  });

  test("a ruleset in evaluate mode blocks nothing", () => {
    const g = mergeGateOf(repo(pr({
      ...writerView,
      rules: { nodes: [
        { type: "UPDATE", repositoryRuleset: { name: "dry run", enforcement: "EVALUATE" }, parameters: null },
        { type: "PULL_REQUEST", repositoryRuleset: { name: "dry run", enforcement: "EVALUATE" },
          parameters: { requiredApprovingReviewCount: 4 } },
      ] },
    })))!;
    expect(g.locked).toBeNull();
    expect(g.approvals).toBe(1);
  });

  test("rulesets and classic protection add up to the stricter of the two", () => {
    const g = mergeGateOf(repo(pr({
      ...writerView,
      rules: { nodes: [
        { type: "PULL_REQUEST", repositoryRuleset: { name: "main", enforcement: "ACTIVE" },
          parameters: { requiredApprovingReviewCount: 3, dismissStaleReviewsOnPush: true, requireCodeOwnerReview: true,
            requireLastPushApproval: false, requiredReviewThreadResolution: true } },
        { type: "REQUIRED_STATUS_CHECKS", repositoryRuleset: { name: "main", enforcement: "ACTIVE" },
          parameters: { strictRequiredStatusChecksPolicy: true, requiredStatusChecks: [{ context: "e2e" }, { context: "build" }] } },
        { type: "REQUIRED_SIGNATURES", repositoryRuleset: { name: "main", enforcement: "ACTIVE" }, parameters: null },
        { type: "MERGE_QUEUE", repositoryRuleset: { name: "main", enforcement: "ACTIVE" }, parameters: null },
      ] },
    })))!;
    expect(g.approvals).toBe(3);
    // A ruleset that says so is an answer even to a writer.
    expect(g.dismissStale).toBe(true);
    expect(g.upToDate).toBe(true);
    expect(g.codeOwners).toBe(true);
    expect(g.conversationResolution).toBe(true);
    expect(g.signatures).toBe(true);
    expect(g.mergeQueue).toBe(true);
    expect(g.requiredContexts).toEqual(["build", "lint", "e2e"]);
  });

  test("a repository with no pull request in the answer has no gate", () => {
    expect(mergeGateOf(null)).toBeNull();
    expect(mergeGateOf({ viewerPermission: "READ" })).toBeNull();
  });

  test("required checks are keyed by workflow and name, check runs and statuses alike", () => {
    const keys = requiredCheckKeys({ pullRequest: { commits: { nodes: [{ commit: { statusCheckRollup: { contexts: { nodes: [
      { name: "build", isRequired: false, checkSuite: { workflowRun: { workflow: { name: "Nightly" } } } },
      { name: "build", isRequired: true, checkSuite: { workflowRun: { workflow: { name: "CI" } } } },
      { context: "ci/legacy", isRequired: true },
      {},
    ] } } } }] } } });
    expect(keys.has(checkKey("CI", "build"))).toBe(true);
    // The same name in another workflow is not made required by it.
    expect(keys.has(checkKey("Nightly", "build"))).toBe(false);
    expect(keys.has(checkKey("", "ci/legacy"))).toBe(true);
    expect(keys.size).toBe(2);
  });
});

describe("how the gate is fetched", () => {
  test("in a query of its own, so a host without these fields still shows the pull request", () => {
    expect(GATE_QUERY).toContain("isRequired(pullRequestNumber:$number)");
    expect(GATE_QUERY).toContain("branchProtectionRule");
    expect(DETAIL_QUERY).not.toContain("isRequired");
    expect(DETAIL_QUERY).not.toContain("branchProtectionRule");
  });

  test("beside the detail, and the detail does not wait on it succeeding", () => {
    const start = src.indexOf("export async function prDetail(");
    expect(start).toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("\n}\n", start));
    expect(body).toMatch(/Promise\.all\(\[\s*ghJson<any>\(\["api", "graphql", "-f", `query=\$\{DETAIL_QUERY\}`/);
    expect(body).toContain("query=${GATE_QUERY}");
    // The detail's own failure check reads only the detail's answer.
    expect(body).toContain("const p = data?.data?.repository?.pullRequest;");
    expect(body).toContain("mergeGateOf(gateData?.data?.repository) ?? undefined");
  });
});
