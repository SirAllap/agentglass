/*
 * The Jira screen with real-shape data: the epic header's numbers, the alerts, the board's per-column scroll and the
 * constant sidebar width. The live scroll and width measures are taken in the dev run (a column scrolled leaves the
 * other columns, the board and the sidebar's width where they were); this file holds the rules that keep them true.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { ProviderTask } from "../../shared/providers.ts";
import { nextStep, progressOf } from "../src/components/jira/list/laneModel.ts";
import { agentUrgency } from "../src/lib/jiraCardWork.ts";

const css = readFileSync(new URL("../src/jiraMock.css", import.meta.url), "utf8");
const card = (id: string, status: string, statusKind = "open", extra: Partial<ProviderTask> = {}): ProviderTask =>
  ({ id, customId: id, title: id, status, statusKind, ...extra }) as unknown as ProviderTask;
const statuses = ["Backlog", "In progress", "Code review", "Ready for QA", "Done"].map((status) => ({ status }));

describe("progress along the workflow", () => {
  test("a done card is full, an unknown status is empty, the rest sit by position", () => {
    expect(progressOf(card("A-1", "Done", "done"), statuses)).toEqual({ done: 5, of: 5 });
    expect(progressOf(card("A-1", "Nowhere"), statuses)).toEqual({ done: 0, of: 5 });
    expect(progressOf(card("A-1", "Backlog"), statuses).done).toBe(1);
    expect(progressOf(card("A-1", "Code review"), statuses).done).toBe(3);
  });
});

describe("the epic's one next step", () => {
  const ci = (bad: string) => (t: ProviderTask) => (t.id === bad ? "failing" : "unknown");
  test("failing checks first, then review, then QA, else nothing", () => {
    const cards = [card("A-1", "Code review"), card("A-2", "Ready for QA"), card("A-3", "In progress")];
    expect(nextStep(cards, ci("A-3"))?.label).toBe("Fix CI A-3");
    expect(nextStep(cards, ci("none"))?.label).toBe("Review A-1");
    expect(nextStep(cards.slice(1), ci("none"))?.label).toBe("QA A-2");
    expect(nextStep([card("A-4", "Backlog")], ci("none"))).toBeNull();
  });
  test("an agent waiting beats one stalled, and a stalled one beats failing checks; both open the Work tab", () => {
    const cards = [card("A-1", "Code review"), card("A-2", "In progress"), card("A-3", "In progress")];
    const is = (id: string) => (t: ProviderTask) => t.id === id;
    expect(nextStep(cards, ci("A-1"), is("A-3"), is("A-2"))).toEqual({ id: "A-3", label: "Answer agent on A-3", work: true });
    expect(nextStep(cards, ci("A-1"), () => false, is("A-2"))).toEqual({ id: "A-2", label: "Check agent on A-2", work: true });
  });
});

describe("how soon an agent wants a look", () => {
  test("waiting, then stalled or errored, then working", () => {
    expect(["working", "errored", "waiting", "stalled"].sort((a, b) => agentUrgency(a) - agentUrgency(b))).toEqual(["waiting", "errored", "stalled", "working"]);
  });
});

describe("the Jira view follows the app theme", () => {
  test("the wrapper reads the app's own tokens; it never redefines them or forces dark", () => {
    const scope = css.match(/\.agx-jmock\s*\{[^}]*\}/)?.[0] ?? "";
    expect(scope).not.toMatch(/color-scheme:\s*dark/);
    expect(scope).not.toMatch(/--(bg|text|border|primary|success|warning|error|info|surface-\w+)\d?:\s*#/);
    expect(css).not.toMatch(/color-scheme:\s*dark/);
  });
});

describe("the board scrolls one column at a time", () => {
  test("the board itself never scrolls down; each column's cards do", () => {
    expect(css).toMatch(/\.agx-jb-percol\s*\{[^}]*overflow-y:\s*hidden/);
    expect(css).toMatch(/\.agx-jb-cards\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.agx-jb-cards\s*\{[^}]*overscroll-behavior:\s*auto\s+contain/);
  });
  test("a column head is outside the scroller, so it stays", () => {
    expect(css).toMatch(/\.agx-jb-colbox > \.agx-jb-colhead\s*\{[^}]*flex:\s*none/);
  });
});
