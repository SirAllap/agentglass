// A check name that runs once per trigger is two checks.
//
// Measured on a real pull request: 71 check runs on the head (58 success, 13
// skipped) and the Checks tab said 69 with 11 skipped. Two job names appeared
// twice, once for `pull_request` and once for `pull_request_review`, and the
// per-name dedupe folded each pair into one. github.com lists both.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "agx-count-event-"));
process.env.XDG_CONFIG_HOME = dir;
process.env.AGENTGLASS_DB = join(dir, "p.db");
const { rollupChecks, withWorkflow } = await import("../src/prs.ts");

// The GraphQL shape, before it is flattened.
const node = (name: string, event: string, conclusion: string, status = "COMPLETED") => ({
  __typename: "CheckRun", name, status, conclusion, detailsUrl: `https://github.com/acme/orbit/actions/runs/1/job/${name}`,
  checkSuite: { workflowRun: { event, workflow: { name: "Review" } } },
});

describe("counting check runs like GitHub", () => {
  const nodes = [
    node("auto-review", "pull_request", "SKIPPED"),
    node("auto-review", "pull_request_review", "SKIPPED"),
    node("claude", "pull_request", "SKIPPED"),
    node("claude", "pull_request_review", "SUCCESS"),
    node("unit", "pull_request", "SUCCESS"),
  ];

  test("same name on two events is two checks", () => {
    const { rollup, all } = rollupChecks(nodes.map(withWorkflow));
    expect(rollup.total).toBe(5);
    expect(rollup.skipped).toBe(3);
    expect(rollup.success).toBe(2);
    expect(all.filter((c) => c.name === "claude").map((c) => c.event).sort()).toEqual(["pull_request", "pull_request_review"]);
  });

  test("a re-run of the same event still replaces the run it repeats", () => {
    const { rollup } = rollupChecks([
      node("unit", "pull_request", "FAILURE"),
      node("unit", "pull_request", "", "IN_PROGRESS"),
    ].map(withWorkflow));
    expect(rollup.total).toBe(1);
    expect(rollup.pending).toBe(1);
    expect(rollup.failure).toBe(0);
  });
});
