/**
 * The board is not a view of the list: it draws two fetches of its own —
 * `mine` and `review` — and never looks at `prs`. So a rule set in the builder
 * narrowed the table behind it and changed no lane at all.
 *
 * Two rules, because the failure needed both and neither can see the other:
 * what `is not` means on a card status, and that the board is handed the
 * filtered arrays — which no unit test can check, since a prop wired to the
 * wrong name still type-checks.
 */
import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { applyWith, type FilterSet } from "../src/components/tasks/filters.ts";
import { readPrField } from "../src/lib/prFilter.ts";
import type { PrSummary } from "../../shared/types.ts";

const pr = (number: number, status: string | null): PrSummary => ({
  number, title: `PR ${number}`, author: "someone", state: "open",
  ...(status
    ? { card: { id: `c${number}`, title: "a card", status, priority: null, people: [] } }
    : null),
} as unknown as PrSummary);

const only = (rows: PrSummary[]) => rows.map((p) => p.number);

test("is not on a card status drops exactly the rows that carry it", () => {
  const rows = [pr(1, "in review"), pr(2, "in progress"), pr(3, "in review"), pr(4, null)];
  const f: FilterSet = { join: "and", rules: [{ id: "r1", field: "cardstatus", op: "not", values: ["in review"] }] };
  /* A pull request with no card survives `is not`: it is not in that status
     because it is in none. Dropping those would empty the board of everything
     the tracker has not seen, which is most of it on a shared repository. */
  expect(only(applyWith(rows, f, readPrField))).toEqual([2, 4]);
});

test("is on a card status keeps exactly those rows", () => {
  const rows = [pr(1, "in review"), pr(2, "in progress"), pr(3, null)];
  const f: FilterSet = { join: "and", rules: [{ id: "r1", field: "cardstatus", op: "is", values: ["in review"] }] };
  expect(only(applyWith(rows, f, readPrField))).toEqual([1]);
});

test("the board is handed the filtered lists, not the raw fetches", () => {
  const src = readFileSync(new URL("../src/components/PrPanel.tsx", import.meta.url), "utf8");
  expect(src).toMatch(/const boardMineShown = useMemo\(\s*\(\) => applyWith\(boardMine\.map\(\(p\) => withCard\(p, hasTaskProvider\)\), rules, readPrField\)/);
  expect(src).toMatch(/const boardReviewShown = useMemo\(\s*\(\) => applyWith\(boardReview\.map\(\(p\) => withCard\(p, hasTaskProvider\)\), rules, readPrField\)/);
  expect(src).toContain("mine={boardMineShown} review={boardReviewShown}");
  /* The raw pair never reaches the component again — the exact shape of the bug. */
  expect(src).not.toContain("mine={boardMine}");
});
