import { describe, expect, test } from "bun:test";
import { mergeCardStatuses } from "../src/prs.ts";

describe("the PR rules' card statuses", () => {
  test("Jira rows and ClickUp statuses are merged, upper case, once each", () => {
    const got = mergeCardStatuses(
      [{ status: "IN REVIEW", type: "custom", color: "#fa0" }],
      [{ status: "In review", type: "custom" }, { status: "Backlog", type: "open" }],
    );
    expect(got.map((x) => x.status)).toEqual(["IN REVIEW", "BACKLOG"]);
    expect(got[0]!.color).toBe("#fa0");
  });
  test("a ClickUp-only repo still offers its statuses", () => {
    expect(mergeCardStatuses([], [{ status: "To do", type: "open" }]).map((x) => x.status)).toEqual(["TO DO"]);
  });
});

describe("tracker tags", () => {
  test("a status carries every tracker that has it", () => {
    const got = mergeCardStatuses(
      [{ status: "Done", tracker: "jira" }, { status: "Backlog", tracker: "jira" }],
      [{ status: "done", tracker: "clickup" }],
    );
    expect(got.find((x) => x.status === "DONE")!.trackers).toEqual(["jira", "clickup"]);
    expect(got.find((x) => x.status === "BACKLOG")!.trackers).toEqual(["jira"]);
  });
});

describe("the Jira read behind the PR board", () => {
  const rows = [{ status: "BACKLOG", type: "new" }, { status: "IN DEVELOPMENT", type: "indeterminate" }];
  test("a failed or slow read falls back to the last good one", async () => {
    const { jiraFacetRead, _resetJiraFacetMemory } = await import("../src/prs.ts");
    _resetJiraFacetMemory();
    expect((await jiraFacetRead(async () => ({ rows, failed: false }))).rows).toEqual(rows);
    expect((await jiraFacetRead(async () => ({ rows: [], failed: true }))).rows).toEqual(rows);
    const slow = await jiraFacetRead(() => new Promise(() => {}), 10);
    expect(slow.rows).toEqual(rows);
    expect(slow.failed).toBe(true);
  });
  test("nothing read and nothing remembered stays empty", async () => {
    const { jiraFacetRead, _resetJiraFacetMemory } = await import("../src/prs.ts");
    _resetJiraFacetMemory();
    expect((await jiraFacetRead(async () => ({ rows: [], failed: true }))).rows).toEqual([]);
  });
});

describe("the PR rules' Jira projects", () => {
  test("the projects of the listed cards reach the workflow read; the rows are the whole workflow", async () => {
    const { jiraFacetRead, _resetJiraFacetMemory } = await import("../src/prs.ts");
    _resetJiraFacetMemory();
    const flow = Array.from({ length: 15 }, (_, i) => ({ status: `STATUS ${i + 1}`, type: "indeterminate" }));
    let asked: readonly string[] = [];
    const got = await jiraFacetRead(async (p) => { asked = p ?? []; return { rows: p?.includes("ORBIT") ? flow : [], failed: false }; }, 1000, ["ORBIT"]);
    expect(asked).toEqual(["ORBIT"]);
    expect(got.rows.length).toBe(15);
  });
});

describe("a project that refuses its read", () => {
  const flow = Array.from({ length: 15 }, (_, i) => ({ status: `STATUS ${i + 1}`, type: "indeterminate" }));
  test("one refused project and one good one: the good one's whole list is kept", async () => {
    const { jiraFacetRead, _resetJiraFacetMemory } = await import("../src/prs.ts");
    _resetJiraFacetMemory();
    const first = await jiraFacetRead(async () => ({ rows: flow, failed: true }), 1000, ["ORBIT", "ACME"]);
    expect(first.rows.length).toBe(15);
    const next = await jiraFacetRead(async () => ({ rows: [], failed: true }));
    expect(next.rows.length).toBe(15);
  });
  test("a read that loses the race still fills the memory and calls onLate", async () => {
    const { jiraFacetRead, _resetJiraFacetMemory } = await import("../src/prs.ts");
    _resetJiraFacetMemory();
    let late = 0;
    const slow = () => new Promise<{ rows: typeof flow; failed: boolean }>((res) => setTimeout(() => res({ rows: flow, failed: true }), 40));
    expect((await jiraFacetRead(slow, 5, [], () => { late++; })).rows).toEqual([]);
    await new Promise((r) => setTimeout(r, 80));
    expect(late).toBe(1);
    expect((await jiraFacetRead(async () => ({ rows: [], failed: true }))).rows.length).toBe(15);
  });
});

describe("a Jira answer that lands after the facets were sent", () => {
  const base = { authors: [], assignees: [], labels: [], milestones: [], bases: [], cardStatuses: [] };
  const cards = [{ status: "BACKLOG" }];
  test("a failed or partial late answer lives 30 s, a whole one the full 20 min", async () => {
    const { lateFacetEntry } = await import("../src/prs.ts");
    const TTL = 20 * 60_000;
    const failed = lateFacetEntry(base, cards, true, 1_000_000);
    expect(failed.at + TTL - 1_000_000).toBe(30_000);
    expect(failed.data.cardStatuses).toEqual(cards);
    expect(lateFacetEntry(base, cards, false, 1_000_000).at).toBe(1_000_000);
  });
});
