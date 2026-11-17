/*
 * One saved view, two callers: the desk's board and the phone's.
 *
 * The evaluator and the field readers are shared (shared/prFilterEval.ts,
 * shared/prFilterFields.ts), but "shared" is a claim a copy can quietly break.
 * This is the one test that runs a single `PrView` over a single fixture list
 * through BOTH doors — the desk's `evalExempt` + `viewFieldReader`, the phone's
 * `inView`/`viewCount` — and requires the same rows, in both directions.
 *
 * The fixture carries the three rows that used to disagree: a second pass that
 * has not landed (`checksLoaded: false`), a field this build does not know, and
 * a red pull request with something unread on it. Both callers must treat the
 * first two as "cannot judge, keep the row" and the third as the desk's
 * exemption.
 *
 * It lives with the desk because this config compiles the phone's model without
 * the phone's stricter `noUncheckedIndexedAccess`, which the desk's own sources
 * are not written for. `updated` is the one clock-dependent field and is left
 * out on purpose: both callers pass their own clock, so a rule on it could
 * disagree by a day between two runs of this test.
 */
import { describe, expect, test } from "bun:test";
import type { PrSummary } from "../../shared/types.ts";
import { emptyLanes, type PrView } from "../../shared/prFilter.ts";
import { prRepoKey, prSeenKey, unreadOf } from "../../shared/prUnread.ts";
import { evalExempt } from "../src/lib/prFilterView.ts";
import { viewFieldReader, readPrField } from "../src/lib/prFilter.ts";
import { ruleAlone, rulePreview } from "../src/components/PrRuleEditor.tsx";
import { inView, viewCount } from "../../mobile/src/model/prBoard.ts";

const NOW = Date.parse("2026-11-05T00:00:00Z");
const REPO = "github.com/acme/orbit";

const pr = (o: Partial<PrSummary> & { fail?: number; pend?: number } = {}): PrSummary => {
  const { fail = 0, pend = 0, ...rest } = o;
  return {
    number: 1, title: "Desk: the strip follows the cursor", author: "ada", state: "OPEN", isDraft: false,
    headRefName: "feat/ORBIT-1042", baseRefName: "main",
    url: `https://github.com/acme/orbit/pull/${o.number ?? 1}`, updatedAt: "2026-11-04T00:00:00Z",
    reviewDecision: null, additions: 10, deletions: 2, changedFiles: 2, labels: [], assignees: [],
    milestone: null, mergeable: "MERGEABLE", checksLoaded: true,
    checks: {
      total: 3 + fail + pend, success: 3, failure: fail, skipped: 0, pending: pend,
      allDone: pend === 0, verdict: pend ? null : fail ? "red" : "green", failing: [],
    },
    ...rest,
  } as PrSummary;
};

const seen = { [prSeenKey(REPO, 327)]: Date.parse("2026-11-01T00:00:00Z") };
const isExempt = (p: PrSummary): boolean => !!unreadOf(p, prRepoKey(p), seen);

/** AND of two `show` rules, one `hide` rule — the shape a saved view actually has. */
const view: PrView = (() => {
  const filter = emptyLanes();
  filter.show.children.push({ id: "s1", field: "author", op: "is", values: ["ada"] });
  filter.show.children.push({ id: "s2", field: "checks", op: "is", values: ["green"] });
  filter.hide.children.push({ id: "h1", field: "label", op: "is", values: ["needs work"] });
  return { id: "orbit-qa", name: "Ready for QA", filter, order: 0 };
})();

const rows: PrSummary[] = [
  pr({ number: 322 }),
  pr({ number: 323, labels: [{ name: "needs work", color: "" }] }),
  pr({ number: 324, author: "rui" }),
  pr({ number: 325, fail: 1 }),
  pr({ number: 326, pend: 1 }),
  // The second pass has not landed: neither caller may read that as "no checks".
  pr({ number: 328, checksLoaded: false }),
  // Red by the rule, but something on it is unread: the desk keeps it.
  pr({
    number: 327, fail: 1,
    talk: [{ at: "2026-11-04T00:00:00Z", who: "rui", kind: "comment" }],
  }),
];

const deskKept = (): number[] =>
  evalExempt(rows, view.filter, viewFieldReader, isExempt).kept.map((p) => p.number);

const phoneKept = (): number[] =>
  inView(rows, view, { now: NOW, exempt: isExempt }).map((p) => p.number);

describe("one view definition, both callers", () => {
  test("the desk's chip count and the phone's are the same rows", () => {
    expect(deskKept()).toEqual([322, 328, 327]);
    expect(phoneKept()).toEqual(deskKept());
    expect(viewCount(rows, view, { now: NOW, exempt: isExempt })).toBe(deskKept().length);
  });

  test("row by row, membership agrees", () => {
    const desk = deskKept();
    for (const row of rows) {
      expect({ number: row.number, kept: inView([row], view, { now: NOW, exempt: isExempt }).length === 1 })
        .toEqual({ number: row.number, kept: desk.includes(row.number) });
    }
  });

  test("a field this build does not know keeps every row on both", () => {
    const f = emptyLanes();
    f.show.children.push({ id: "s1", field: "invented", op: "is", values: ["x"] });
    // `unset` on an unknown field would hide every row if the field read as empty.
    f.hide.children.push({ id: "h1", field: "also-invented", op: "unset", values: [] });
    const unknown: PrView = { id: "from-a-newer-build", name: "Newer", filter: f, order: 0 };
    const desk = evalExempt(rows, unknown.filter, viewFieldReader, isExempt).kept.map((p) => p.number);
    const phone = inView(rows, unknown, { now: NOW, exempt: isExempt }).map((p) => p.number);
    expect(desk).toEqual(rows.map((p) => p.number));
    expect(phone).toEqual(desk);
  });

  test("a rule naming a prototype key narrows nothing and does not throw", () => {
    for (const field of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const f = emptyLanes();
      f.show.children.push({ id: "s1", field, op: "is", values: ["x"] });
      const odd: PrView = { id: `proto-${field}`, name: field, filter: f, order: 0 };
      expect(evalExempt(rows, odd.filter, viewFieldReader, isExempt).kept).toHaveLength(rows.length);
      expect(inView(rows, odd, { now: NOW, exempt: isExempt })).toHaveLength(rows.length);
    }
  });

  test("the fixture is one the view really narrows", () => {
    // A test that would pass with an empty view proves nothing about narrowing.
    expect(rows.length).toBeGreaterThan(deskKept().length);
    expect(deskKept().length).toBeGreaterThan(0);
  });

  /* The rule editor's own preview: "Takes N of M off the board" and the rows it
     names. It must judge with the board's reader, or it names a row that stays. */
  test("a rule's preview takes the rows Apply takes, second pass or not", () => {
    const rule = { id: "s1", field: "checks", op: "is" as const, values: ["green"] };
    const two = [pr({ number: 401, fail: 1 }), pr({ number: 402, checksLoaded: false })];
    expect(rulePreview(two, "show", rule, viewFieldReader).map((p) => p.number)).toEqual([401]);
    // The reader that folds null into [] names both; that is the defect the
    // board does not have. Literal on both sides, so a fixture cannot agree.
    expect(rulePreview(two, "show", rule, readPrField).map((p) => p.number)).toEqual([401, 402]);
    const boardKept = evalExempt(two, ruleAlone("show", rule), viewFieldReader, () => false).kept.map((p) => p.number);
    expect(boardKept).toEqual([402]);
  });

  test("the desk's deck previews with the board's reader, not the old one", async () => {
    const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
    expect(panel).toContain("fields={ruleFields} read={viewFieldReader}");
  });
});
