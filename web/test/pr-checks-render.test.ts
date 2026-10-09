/*
 * The Checks tab, drawn. A pull request with 71 runs on its head (58
 * successful, 13 skipped, two names run once per trigger) must say exactly
 * that, put what needs a person above everything that does not, and fold the
 * passed checks by workflow.
 */
import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Checks } from "../src/components/PrPanel.tsx";
import type { PrCheck } from "../../shared/types.ts";

const mk = (name: string, state: PrCheck["state"], o: Partial<PrCheck> = {}): PrCheck =>
  ({ name, workflow: "CI", state, done: state !== "pending", event: "pull_request", url: "https://github.com/acme/orbit/actions/runs/1", ...o });
const at = (dur: number) => ({ startedAt: "2026-09-30T09:00:00Z", completedAt: new Date(Date.parse("2026-09-30T09:00:00Z") + dur * 1000).toISOString() });

const draw = (all: PrCheck[]) => {
  const n = (s: PrCheck["state"]) => all.filter((k) => k.state === s).length;
  const checks = { total: all.length, success: n("success"), failure: n("failure"), skipped: n("skipped"), pending: n("pending"), allDone: n("pending") === 0, verdict: "green", failing: [] };
  return renderToStaticMarkup(React.createElement(Checks, { d: { number: 1, checks, checksAll: all } as never, root: "/x", jobs: [], onRerun() {}, busy: false }));
};

describe("Checks tab", () => {
  const green = [
    ...Array.from({ length: 58 }, (_, i) => mk(`job ${i}`, "success", { ...at(60 + i), ...(i === 0 ? { required: true } : {}) })),
    mk("claude", "skipped"), mk("claude", "skipped", { event: "pull_request_review" }),
    ...Array.from({ length: 11 }, (_, i) => mk(`opt ${i}`, "skipped", { workflow: "Optional" })),
  ];
  test("a green PR says so, with GitHub's numbers, and pins nothing", () => {
    const html = draw(green);
    expect(html).toContain("All checks have passed");
    expect(html).toContain("58 passed · 13 skipped");
    expect(html).toContain("1/1 required passed");
    expect(html).toContain("13 skipped checks");
    expect(html).toContain("Nothing needs you");
    expect(html).not.toContain("Needs attention");
  });

  test("a failing check is pinned above the workflow cards with its own words", () => {
    const html = draw([...green.slice(0, 5), mk("e2e (checkout)", "failure", { ...at(505), title: "3 tests failed" })]);
    expect(html).toContain("1 check failing");
    expect(html).toContain("Needs attention");
    expect(html).toContain("CI / e2e · checkout");
    expect(html).toContain("3 tests failed");
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("aria-expanded"));
  });

  test("a job that always takes 15m is not amber; one that got slower is (the card's strip is drawn folded)", () => {
    const u = (m: number) => ({ usual: { median: m * 60_000, p90: m * 66_000, n: 20 } });
    const html = draw([mk("evals", "success", { workflow: "Evals", ...at(15 * 60), ...u(14) }), mk("unit", "success", { ...at(9 * 60), ...u(4) })]);
    const strip = (card: string) => html.slice(html.indexOf(`>${card}<`)).match(/<span class="rounded-sm" style="[^"]*background:([^"]*)"/)![1];
    expect(strip("Evals")).not.toContain("warning");
    expect(strip("Evals")).not.toContain("error");
    expect(strip("CI")).toContain("var(--warning)");
    expect(html).toContain("Slower than usual 1");
    expect(html).not.toContain("Slow ≥5m");
  });
});
