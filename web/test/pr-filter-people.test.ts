/*
 * "Can the finder search by assignee name?"
 *
 * It could not. The box matched the number, the title and the AUTHOR — which
 * answers "whose pull request is this" and never "where is Ada on this",
 * while the card under the cursor said "Waiting on adadoe" in as many
 * words. On a board of 389 open pull requests that is the question people
 * actually type into it.
 *
 * Assignees and requested reviewers both. On this board they are one question
 * wearing two hats — who owns it, and who is being waited on — and somebody
 * looking for their own name does not care which column it landed in. The
 * facets stay the exact filters they were; this is the free-text box, where a
 * partial name is the point.
 *
 * Logins, not display names: a display name is not on a list row at all, so
 * matching one would cost a fetch per row.
 */
import { describe, expect, it } from "bun:test";
import { applyFilters, peopleMatched, parseQuery } from "../src/lib/prFilter.ts";
import type { PrSummary } from "../../shared/types.ts";

const pr = (over: Partial<PrSummary>): PrSummary => ({
  number: 1, title: "Round prices at the cart boundary", author: "alexdoe", state: "OPEN",
  isDraft: false, updatedAt: "2026-08-14T10:00:00Z", createdAt: "2026-08-01T10:00:00Z",
  url: "https://github.com/acme/shop-api/pull/1", headRefName: "ORBIT-1042", baseRefName: "main",
  additions: 1, deletions: 1, changedFiles: 1, labels: [], assignees: [], milestone: null,
  checks: { state: "SUCCESS", total: 1, passed: 1, failed: 0, pending: 0 },
  ...over,
} as PrSummary);

const find = (rows: PrSummary[], text: string) => applyFilters(rows, { ...parseQuery(""), text }).map((p) => p.number);

describe("the free-text box", () => {
  it("finds a pull request by the person assigned to it", () => {
    const rows = [pr({ number: 10, assignees: ["adadoe"] }), pr({ number: 11 })];
    expect(find(rows, "ada")).toEqual([10]);
  });

  it("finds one by who was asked to review it", () => {
    const rows = [pr({ number: 20, reviewers: [{ login: "adadoe" }] }), pr({ number: 21 })];
    expect(find(rows, "ada")).toEqual([20]);
  });

  it("still finds the old three: number, title and author", () => {
    const rows = [pr({ number: 30, title: "Cart totals" }), pr({ number: 31, title: "Ledger", author: "adadoe" })];
    expect(find(rows, "cart")).toEqual([30]);
    expect(find(rows, "31")).toEqual([31]);
    expect(find(rows, "adad")).toEqual([31]);
  });

  it("does not match a person who is not on it", () => {
    expect(find([pr({ number: 40, assignees: ["alexdoe"] })], "ada")).toEqual([]);
  });
});

describe("why the row is in the answer", () => {
  it("names the person, when the person is the reason", () => {
    const row = pr({ assignees: ["adadoe"], reviewers: [{ login: "ada-b" }] });
    expect(peopleMatched(row, "ada")).toEqual(["adadoe", "ada-b"]);
  });

  it("says nothing when the title or the author already explains it", () => {
    // A row that matched its own title is legible without help; a chip there is
    // noise on every row of a title search.
    expect(peopleMatched(pr({ title: "ada's refactor", assignees: ["adadoe"] }), "ada")).toEqual([]);
    expect(peopleMatched(pr({ author: "adadoe", assignees: ["adadoe"] }), "ada")).toEqual([]);
  });

  it("says nothing when the box is empty", () => {
    expect(peopleMatched(pr({ assignees: ["adadoe"] }), "")).toEqual([]);
  });
});
