/*
 * The budgets pane, and the properties that keep it from lying about money.
 *
 * A budget is a denominator on somebody's dashboard, so the assertions worth
 * having are about the ways it could show a plausible wrong number: a half-typed
 * row saved as a real limit, a percentage bar that pretends 180% is 100%, or a
 * window that does not say which days it covers.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const read = (p: string) => readFileSync(new URL("../" + p, import.meta.url), "utf8");
const pane = read("src/components/BudgetsPane.tsx");

describe("setting one", () => {
  test("a row being filled in is not saved as a budget", () => {
    // Adding a row starts it at zero, and the moment it were sent it would be
    // either refused by the server or — worse — treated as a limit of nothing.
    expect(pane).toContain("next.filter((b) => b.limit > 0)");
  });

  test("the whole set is sent, because a row has no identity", () => {
    // Two budgets can differ only by a limit somebody is halfway through
    // typing, so there is nothing for a partial update to address.
    expect(pane).toContain("api.budgetsSet(ready)");
  });

  test("the limit field accepts only digits and a point", () => {
    // It is bound straight to a number. Letters would land as NaN and every
    // percentage computed from it would render as "NaN%".
    expect(pane).toMatch(/replace\(\/\[\^0-9\.\]\/g, ""\)/);
  });

  test("and the projects and models are picked, not typed", () => {
    // A budget attached to a path with a typo in it silently measures nothing
    // and reports zero spend forever, which looks exactly like being under.
    expect(pane).toContain("api.gitRepos()");
    expect(pane).toContain("setModels(r.models)");
  });

  test("a project or model that is no longer offered is still shown", () => {
    // A repo that has moved, or a model that has not been used this month, must
    // not silently reassign somebody's budget to "everything" on next render.
    expect(pane).toContain("!roots.includes(b.root)");
    expect(pane).toContain("!models.includes(b.model)");
  });
});

describe("showing where it stands", () => {
  test("the bar is capped even though the percentage is not", () => {
    // 180% is the useful number and a bar 1.8× its own width is a layout bug.
    expect(pane).toContain("Math.min(1, s.pct)");
    expect(pane).toContain("Math.round(s.pct * 100)");
  });

  test("says which days it counted, rather than implying all of them", () => {
    expect(pane).toContain("{s.fromDay} to {s.toDay}");
  });

  test("and says where the number comes from, since it crosses the retention boundary", () => {
    // The thing that makes a monthly budget mean a month: raw events are kept
    // for eight days by default, so without the rollup this would be a weekly
    // budget wearing a monthly label.
    expect(pane).toMatch(/rollup as well as live events/);
    expect(pane).toContain("AGENTGLASS_RETENTION_DAYS");
  });

  test("and that the warning comes before the limit", () => {
    // A budget you hear about only once you cross it is a receipt, not a
    // control — worth saying, because the user cannot see the threshold.
    expect(pane).toMatch(/warned at 80%/);
  });
});
