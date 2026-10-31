import { describe, expect, test } from "bun:test";
import { askSource, askedOrder } from "../src/lib/prPeopleSource.ts";
import { askView } from "../src/lib/prAskWho.ts";
import type { ReviewerRow } from "../src/lib/prReviewers.ts";

// The people of acme/orbit; dana-r opened the pull request.
const users = ["dana-r", "mara-k", "theo-w", "kofi-o", "lena-p"];
const base = {
  mode: "reviewers" as const, author: "dana-r", roster: [] as ReviewerRow[], users, assignable: ["dana-r", "mara-k", "ines-r"],
  assigned: [] as string[], owners: [] as { owner: string; paths: string[] }[], use: {},
};

describe("who has been asked, in the order that costs least to read", () => {
  const roster: ReviewerRow[] = [
    { login: "kofi-o", state: "awaiting" },
    { login: "theo-w", state: "changes", at: "2026-10-02T10:00:00Z" },
    { login: "mara-k", state: "approved", at: "2026-10-01T10:00:00Z" },
    { login: "lena-p", state: "approved", at: "2026-10-03T10:00:00Z" },
    { login: "build-bot", state: "approved", at: "2026-10-04T10:00:00Z", isBot: true },
    { login: "acme/qa", state: "awaiting", isTeam: true },
  ];
  test("an approval the new commits outran first, then the rest by recency, awaiting last; bots and teams are not people", () => {
    const order = askedOrder(roster, "2026-10-02T12:00:00Z");
    expect(order.map((a) => a.login)).toEqual(["mara-k", "lena-p", "theo-w", "kofi-o"]);
  });
  test("without a later commit nothing is stale: most recent first", () => {
    expect(askedOrder(roster).map((a) => a.login)).toEqual(["lena-p", "theo-w", "mara-k", "kofi-o"]);
  });
});

describe("what the repository suggests", () => {
  test("owners of the changed files come first with a reason, then habit; each person once", () => {
    const s = askSource({ ...base, owners: [{ owner: "@mara-k", paths: ["a.ts", "b.ts"] }, { owner: "@theo-w", paths: ["c.ts"] }],
      use: { "theo-w": { n: 4, at: Date.now() }, "kofi-o": { n: 2, at: Date.now() } } });
    expect(s.suggested).toEqual([
      { login: "mara-k", reason: "Code owner of 2 changed files" },
      { login: "theo-w", reason: "Code owner of c.ts" },
      { login: "kofi-o", reason: "You ask them often" },
    ]);
  });
  test("an owner who is not a collaborator is not invented into the list", () => {
    expect(askSource({ ...base, owners: [{ owner: "@ghost-x", paths: ["a.ts"] }] }).suggested).toEqual([]);
  });
  test("a CODEOWNERS team is a team row, named without the @, and counted by nobody", () => {
    const s = askSource({ ...base, owners: [{ owner: "@acme/relay-core", paths: ["a.ts"] }] });
    expect(s.teams).toEqual([{ slug: "acme/relay-core" }]);
    const v = askView({ ...s, mode: "reviewers", author: "dana-r", repo: "acme/orbit", picked: [], query: "" });
    expect(v.sections.find((x) => x.id === "teams")!.rows[0]).toMatchObject({ id: "@acme/relay-core", sub: "Team" });
  });
});

describe("assignees", () => {
  test("the assignable logins, the current ones held, no teams and no review state", () => {
    const s = askSource({ ...base, mode: "assignees", assigned: ["mara-k"], roster: [{ login: "x", state: "approved" }] });
    expect(s.people.map((p) => p.login)).toEqual(["dana-r", "mara-k", "ines-r"]);
    expect(s.teams).toEqual([]);
    expect(s.asked).toEqual([]);
    expect(s.assigned).toEqual(["mara-k"]);
  });
  test("habit is worded for assigning", () => {
    expect(askSource({ ...base, mode: "assignees", use: { "ines-r": { n: 3, at: Date.now() } } }).suggested).toEqual([{ login: "ines-r", reason: "You assign them often" }]);
  });
});
