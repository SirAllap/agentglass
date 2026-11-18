import { describe, expect, test } from "bun:test";
import { needsFrom, needsHeading, checksSummary, latestActivity, detailRows, clip, CHECK_ROWS_MAX } from "../src/lib/prOverviewBody.ts";
import type { PathRow } from "../../shared/mergePath.ts";
import type { PrCheck } from "../../shared/types.ts";

const row = (o: Partial<PathRow> & Pick<PathRow, "kind" | "title">): PathRow => ({
  id: o.id ?? `${o.kind}:${o.title}`, n: 1, stage: "merge", why: "", mover: "other", moverLabel: "", counted: true, ...o,
} as PathRow);
const chk = (name: string, o: Partial<PrCheck> = {}): PrCheck => ({ name, workflow: "ci", state: "success", done: true, ...o } as PrCheck);

describe("needsFrom", () => {
  test("groups failing checks into one row with the re-run action", () => {
    const n = needsFrom([row({ kind: "check-failing", title: "lint" }), row({ kind: "check-failing", title: "e2e-shard-3" }), row({ kind: "check-failing", title: "unit" }), row({ kind: "check-failing", title: "types" })], { canFixConflicts: false });
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ lead: "4 checks failed:", mono: ["lint", "e2e-shard-3", "unit"], more: 1, act: { id: "rerun", label: "Re-run failed" } });
  });
  test("conflicts get Fix in terminal only when a terminal exists", () => {
    const r = [row({ kind: "conflicts", title: "4 files conflict with main", why: "billing/totals.py and 3 more." })];
    expect(needsFrom(r, { canFixConflicts: true })[0]?.act?.id).toBe("fix-conflicts");
    expect(needsFrom(r, { canFixConflicts: false })[0]?.act).toBeUndefined();
  });
  test("changes requested asks again; a waiting reviewer is nudged", () => {
    const n = needsFrom([
      row({ kind: "review-required", title: "Waiting for review from ana", person: { login: "ana", state: "requested" }, mover: "reviewer" }),
      row({ kind: "changes", title: "jonas · changes requested", sub: "6 hours ago" }),
    ], { canFixConflicts: false });
    expect(n.map((x) => x.act?.id)).toEqual(["ask-review", "nudge"]);
    expect(n[0]!.lead).toBe("jonas asked for changes.");
  });
  test("notes and approvals are not blockers; blockers come before waits", () => {
    const n = needsFrom([row({ kind: "note", title: "x" }), row({ kind: "approved", title: "y" }), row({ kind: "check-running", title: "e2e" }), row({ kind: "conflicts", title: "Conflicts" })], { canFixConflicts: false });
    expect(n.map((x) => x.id)).toEqual(["conflicts:Conflicts", "checks-running"]);
  });
  test("heading says waiting when nothing blocks", () => {
    expect(needsHeading(needsFrom([row({ kind: "check-running", title: "e2e" })], { canFixConflicts: false }))).toBe("What it is waiting for");
    expect(needsHeading(needsFrom([row({ kind: "check-failing", title: "e2e" })], { canFixConflicts: false }))).toBe("What is in the way");
  });
});

describe("checksSummary", () => {
  test("counts, label, bar and failed-first rows capped", () => {
    const cs = [chk("a"), chk("b"), chk("c"), chk("d"), chk("e"), chk("lint", { state: "failure" }), chk("run", { done: false, state: "pending" })];
    const s = checksSummary(cs);
    expect(s).toMatchObject({ ok: 5, bad: 1, run: 1, total: 7, label: "5 of 7" });
    expect(s.rows).toHaveLength(CHECK_ROWS_MAX);
    expect(s.rows.map((r) => r.name).slice(0, 2)).toEqual(["lint", "run"]);
    expect(s.rows[1]!.dur).toBe("running");
  });
  test("duration formats minutes and seconds", () => {
    const s = checksSummary([chk("x", { startedAt: "2026-01-01T00:00:00Z", completedAt: "2026-01-01T00:03:12Z" })]);
    expect(s.rows[0]!.dur).toBe("3m 12s");
  });
});

describe("latestActivity", () => {
  const d = {
    comments: [
      { id: 1, author: "mira", isBot: false, body: "Good catch.\n\nAdded a version column.", createdAt: "2026-01-02T10:00:00Z" },
      { id: 2, author: "ci-bot", isBot: true, body: "coverage", createdAt: "2026-01-02T12:00:00Z" },
    ],
    reviews: [{ author: "jonas", isBot: false, state: "CHANGES_REQUESTED", body: "Stale if a refund lands.", submittedAt: "2026-01-02T09:00:00Z", nodeId: "n1" }],
  } as never;
  test("newest two by people, oldest first, bots ignored", () => {
    const a = latestActivity(d);
    expect(a.map((x) => x.author)).toEqual(["jonas", "mira"]);
    expect(a[0]!.verb).toBe("asked for changes");
    expect(a[1]!.body).toBe("Good catch. Added a version column.");
  });
  test("clip adds an ellipsis", () => {
    expect(clip("a".repeat(300), 10)).toBe("aaaaaaaaa…");
  });
});

describe("detailRows", () => {
  const base = { assignees: [], milestone: "", linkedIssues: [], state: "OPEN" } as never;
  test("always offers assignee and milestone", () => {
    const r = detailRows(base, {});
    expect(r.map((x) => x.key)).toEqual(["assignee", "milestone"]);
    expect(r.every((x) => x.none)).toBe(true);
  });
  test("closes, auto-merge and spend appear when they have something to say", () => {
    const r = detailRows({ assignees: ["mira"], milestone: "Q4", linkedIssues: [{ number: 455, title: "t", url: "u", state: "OPEN" }], state: "OPEN" } as never, { spend: "$1.84", autoMerge: false });
    expect(r.map((x) => [x.key, x.value])).toEqual([["assignee", "mira"], ["milestone", "Q4"], ["closes", "#455"], ["auto-merge", "Off"], ["spend", "$1.84"]]);
  });
});

describe("needsFrom: stacked on an open pull request", () => {
  test("names the base first and gives it no button", () => {
    const n = needsFrom([row({ kind: "check-failing", title: "lint" })], { canFixConflicts: false, stackBase: 479 });
    expect(n[0]).toMatchObject({ id: "stack-base", lead: "#479 is not merged yet.", tone: "bad" });
    expect(n[0].act).toBeUndefined();
    expect(n.length).toBe(2);
  });
  test("no base, no row", () => {
    expect(needsFrom([], { canFixConflicts: false }).length).toBe(0);
  });
});
