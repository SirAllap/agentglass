// The board's Human reviewer / Human review / Bot review rule fields: a bot's
// approval is not a person's review, and "only bot reviews, no human" is two rules.
import { describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { isBotLogin } from "../../shared/botLogin.ts";
import { reviewStatesOf } from "../../shared/reviewStates.ts";
import { readPrField, viewFieldReader, FACETS, builderFields, buildFacets, parseQuery, serializeQuery, applyFilters } from "../src/lib/prFilter.ts";
import { sentence } from "../src/lib/prFilterSentence.ts";
import { evalLanes } from "../src/lib/prFilterEval.ts";
import type { LaneFilter } from "../../shared/prFilter.ts";

const rv = (login: string, state: string) => ({ author: { login }, state });
const BOT = "acme-bot[bot]";
const lanes: LaneFilter = {
  show: { id: "s", kind: "group", join: "and", children: [{ id: "r1", field: "botreview", op: "is", values: ["approved"] }] },
  hide: { id: "h", kind: "group", join: "and", children: [{ id: "r2", field: "humanreviewer", op: "is", values: ["assigned"] }] },
};

function pr(over: Partial<PrSummary> = {}): PrSummary {
  return {
    number: 1, mergeable: "MERGEABLE", title: "t", author: "orbit-author", state: "OPEN", isDraft: false,
    headRefName: "f", baseRefName: "main", url: "", updatedAt: "2026-07-20T00:00:00Z", reviewDecision: null,
    additions: 0, deletions: 0, changedFiles: 0, labels: [], assignees: [], milestone: null,
    checks: { total: 0, success: 0, failure: 0, skipped: 0, pending: 0, allDone: false, verdict: null, failing: [] },
    checksLoaded: true, ...over,
  };
}
const withStates = (nodes: unknown[], o: Parameters<typeof reviewStatesOf>[1] = {}, over: Partial<PrSummary> = {}) =>
  pr({ reviewStates: reviewStatesOf(nodes, { author: "orbit-author", ...o }), ...over });

describe("isBotLogin", () => {
  test("[bot] suffix and the known plain-login bots", () => {
    expect(isBotLogin(BOT)).toBe(true);
    expect(isBotLogin("claude")).toBe(true);
    expect(isBotLogin("orbit-dev")).toBe(false);
  });
});

describe("reviewStatesOf", () => {
  test("latest standing state per person; a comment does not undo an approval", () => {
    const s = reviewStatesOf([rv("orbit-dev", "CHANGES_REQUESTED"), rv("orbit-dev", "APPROVED"), rv("orbit-dev", "COMMENTED")], { author: "orbit-author" });
    expect(s.humans).toEqual([{ login: "orbit-dev", state: "approved" }]);
  });
  test("a dismissed verdict stands for nothing; a draft review is ignored", () => {
    const s = reviewStatesOf([rv("orbit-dev", "APPROVED"), rv("orbit-dev", "DISMISSED"), rv("orbit-new", "PENDING")], {});
    expect(s.humans).toEqual([]);
    const c = reviewStatesOf([rv("orbit-dev", "APPROVED"), rv("orbit-dev", "DISMISSED"), rv("orbit-dev", "COMMENTED")], {});
    expect(c.humans).toEqual([{ login: "orbit-dev", state: "comment" }]);
  });
  test("a re-requested reviewer is pending again, whatever they said before", () => {
    const s = reviewStatesOf([rv("orbit-a", "APPROVED"), rv("orbit-b", "CHANGES_REQUESTED")], { pending: ["orbit-a", "orbit-b"] });
    expect(s.humans).toEqual([{ login: "orbit-a", state: "pending" }, { login: "orbit-b", state: "pending" }]);
  });
  test("a bot is found by its GraphQL type, not only by its login", () => {
    const typed = { author: { login: "acme-reviewer", __typename: "Bot" }, state: "APPROVED" };
    const s = reviewStatesOf([typed, rv("orbit-dev", "COMMENTED")], {});
    expect(s.bots).toEqual([{ login: "acme-reviewer", state: "approved" }]);
    expect(s.humans).toEqual([{ login: "orbit-dev", state: "comment" }]);
  });
  test("a requested bot is pending", () => {
    const s = reviewStatesOf([], { pending: ["acme-reviewer[bot]"] });
    expect(s.bots).toEqual([{ login: "acme-reviewer[bot]", state: "pending" }]);
    expect(s.humans).toEqual([]);
  });
  test("bots and people are split; the author and teams are not people", () => {
    const s = reviewStatesOf([rv(BOT, "APPROVED"), rv("orbit-author", "COMMENTED")], {
      author: "orbit-author", pending: ["orbit-dev", "orbit-team"], teams: ["orbit-team"],
    });
    expect(s.humans).toEqual([{ login: "orbit-dev", state: "pending" }]);
    expect(s.bots).toEqual([{ login: BOT, state: "approved" }]);
  });
  test("a request outranks a bare comment and an older verdict", () => {
    const s = reviewStatesOf([rv("orbit-a", "COMMENTED"), rv("orbit-b", "APPROVED")], { pending: ["orbit-a", "orbit-b"] });
    expect(s.humans).toEqual([{ login: "orbit-a", state: "pending" }, { login: "orbit-b", state: "pending" }]);
  });
});

describe("the three fields", () => {
  const botOnly = withStates([rv(BOT, "APPROVED")], {}, { reviewDecision: "APPROVED" });
  const human = withStates([rv("orbit-dev", "APPROVED"), rv(BOT, "CHANGES_REQUESTED")], {}, { reviewDecision: "APPROVED" });
  const asked = withStates([], { pending: ["orbit-dev"] });
  const nobody = withStates([]);

  test("Human reviewer: assigned means requested or reviewed", () => {
    expect(readPrField(botOnly, "humanreviewer")).toEqual(["unassigned"]);
    expect(readPrField(human, "humanreviewer")).toEqual(["assigned"]);
    expect(readPrField(asked, "humanreviewer")).toEqual(["assigned"]);
    expect(readPrField(nobody, "humanreviewer")).toEqual(["unassigned"]);
  });
  test("Human review: any person in that state; None = no person reviewed", () => {
    expect(readPrField(botOnly, "humanreview")).toEqual(["none"]);
    expect(readPrField(human, "humanreview")).toEqual(["approved"]);
    expect(readPrField(asked, "humanreview")).toEqual(["pending"]);
    const mixed = withStates([rv("orbit-a", "APPROVED"), rv("orbit-b", "CHANGES_REQUESTED"), rv("orbit-c", "COMMENTED")]);
    expect(readPrField(mixed, "humanreview").sort()).toEqual(["approved", "changes-requested", "commented"]);
  });
  test("Bot review", () => {
    expect(readPrField(botOnly, "botreview")).toEqual(["approved"]);
    expect(readPrField(human, "botreview")).toEqual(["changes-requested"]);
    expect(readPrField(nobody, "botreview")).toEqual(["none"]);
  });
  test("until the second pass lands the fields say nothing (inert, not 'no')", () => {
    const early = pr({ checksLoaded: false });
    for (const f of ["humanreviewer", "humanreview", "botreview"]) {
      expect(FACETS.find((x) => x.queryKey === f)!.field(early)).toBeNull();
    }
  });
  test("'only bot reviews, no human' = show Bot review Approved + hide Human reviewer assigned", () => {
    const rows = [botOnly, human, asked, nobody].map((p, i) => ({ ...p, number: i + 1 }));
    const r = evalLanes(rows, lanes, viewFieldReader);
    expect(r.kept.map((p) => p.number)).toEqual([1]);
  });
});

describe("editor", () => {
  test("Reviews keeps its key and is renamed; the new fields are offered with counts per value", () => {
    expect(FACETS.find((f) => f.queryKey === "review")!.label).toBe("Reviews (anyone)");
    const rows = [
      withStates([rv(BOT, "APPROVED")]),
      withStates([rv("orbit-dev", "APPROVED")]),
      withStates([], { pending: ["orbit-dev"] }),
    ];
    const f = parseQuery("");
    const by = Object.fromEntries(buildFacets(rows, f).map((v) => [v.queryKey, v]));
    const count = (k: string, v: string) => by[k]!.options.find((o) => o.value === v)!.count;
    expect(count("humanreviewer", "assigned")).toBe(2);
    expect(count("humanreviewer", "unassigned")).toBe(1);
    expect(count("humanreview", "approved")).toBe(1);
    expect(count("humanreview", "pending")).toBe(1);
    expect(count("humanreview", "none")).toBe(1);
    expect(count("botreview", "approved")).toBe(1);
    expect(count("botreview", "none")).toBe(2);
    expect(by.humanreview!.options.map((o) => o.label)).toEqual(["Approved", "Changes requested", "Commented", "Pending", "None"]);
    expect(builderFields(rows, f).map((x) => x.key)).toContain("botreview");
  });
  test("query string round-trips and filters", () => {
    const rows = [withStates([rv(BOT, "APPROVED")]), withStates([rv("orbit-dev", "APPROVED")])].map((p, i) => ({ ...p, number: i + 1 }));
    const q = parseQuery("humanreview:approved");
    expect(serializeQuery(q)).toBe("humanreview:approved");
    expect(applyFilters(rows, q).map((p) => p.number)).toEqual([2]);
  });
  test("the sentence reads", () => {
    const text = sentence(lanes).map((s) => s.t).join("");
    expect(text).toBe("Show PRs whose bot review is approved. Hide any whose human reviewer is assigned.");
  });
});
