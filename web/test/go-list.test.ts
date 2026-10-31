/*
 * The Go list under the project chip: what needs you first, then the project
 * you are in, then the others (each with its keep-in-strip switch), narrowed by
 * what was typed, with the arrow keys and Enter working over the same flat list.
 */
import { describe, expect, test } from "bun:test";
import type { TmuxWindow } from "../../shared/types.ts";
import { buildGroups } from "../src/lib/tabGroups.ts";
import { goList, moveSelection, pickRow } from "../src/lib/goList.ts";

const win = (index: number, name: string, repo: string, over: Partial<TmuxWindow> = {}): TmuxWindow => ({
  id: `@${index}`, index, name, active: false, flags: "", repo: `/home/dev/code/${repo}`, ...over,
});
const fleet = [
  win(1, "api", "orbit"), win(2, "invoices", "billing", { status: "waiting" }), win(3, "web", "orbit"),
  win(4, "infra", "platform"), win(5, "ledger", "billing"), win(6, "docs", "orbit", { status: "waiting" }),
];
const list = (over: Partial<Parameters<typeof goList>[0]> = {}) =>
  goList({ groups: buildGroups(fleet, []), current: "orbit", kept: new Set(), query: "", ...over });
const ids = (rows: { window: TmuxWindow }[]) => rows.map((r) => r.window.name);

describe("sections", () => {
  test("Needs you first, across every project, in group order", () => {
    expect(ids(list().needsYou)).toEqual(["docs", "invoices"]);
  });
  test("a blocked window is listed once: under Needs you, not again under its project", () => {
    const l = list();
    expect(ids(l.here!.rows)).toEqual(["api", "web"]);
    expect(ids(l.others[0]!.rows)).toEqual(["ledger"]);
  });
  test("the current project is 'here', the others follow in group order", () => {
    const l = list();
    expect(l.here!.key).toBe("orbit");
    expect(l.others.map((s) => s.key)).toEqual(["billing", "platform"]);
  });
  test("a project's count is all its windows, blocked or not", () => {
    const l = list();
    expect(l.here!.count).toBe(3);
    expect(l.others[0]!.count).toBe(2);
  });
  test("each other project says whether it is kept in the strip", () => {
    const l = list({ kept: new Set(["billing"]) });
    expect(l.others.map((s) => [s.key, s.kept])).toEqual([["billing", true], ["platform", false]]);
  });
  test("the flat row order is Needs you, here, others: what the arrows walk", () => {
    expect(ids(list().rows)).toEqual(["docs", "invoices", "api", "web", "ledger", "infra"]);
  });
});

describe("filter", () => {
  test("matches the window name, case-insensitively", () => {
    expect(ids(list({ query: "LED" }).rows)).toEqual(["ledger"]);
  });
  test("matches the project", () => {
    expect(ids(list({ query: "platf" }).rows)).toEqual(["infra"]);
  });
  test("matches the branch when the caller knows it", () => {
    const l = list({ query: "fix-login", branches: new Map([["@3", "fix-login"]]) });
    expect(ids(l.rows)).toEqual(["web"]);
    expect(l.rows[0]!.branch).toBe("fix-login");
  });
  test("every word must match, in any order", () => {
    expect(ids(list({ query: "orbit docs" }).rows)).toEqual(["docs"]);
    expect(ids(list({ query: "orbit ledger" }).rows)).toEqual([]);
  });
  test("a section with no match disappears, but a kept count stays the whole project", () => {
    const l = list({ query: "ledger" });
    expect(l.here).toBeNull();
    expect(l.needsYou).toEqual([]);
    expect(l.others.map((s) => [s.key, s.count])).toEqual([["billing", 2]]);
  });
  test("nothing matches: no rows", () => {
    expect(list({ query: "zzz" }).rows).toEqual([]);
  });
  test("blank query is no filter", () => {
    expect(list({ query: "   " }).rows).toHaveLength(6);
  });
});

describe("numbers", () => {
  test("a row carries the strip's number for its window, and none for a folded one", () => {
    const numbers = new Map([["@1", 1], ["@6", 3]]);
    const byName = Object.fromEntries(list({ numbers }).rows.map((r) => [r.window.name, r.number]));
    expect(byName).toMatchObject({ api: 1, docs: 3, invoices: null, infra: null });
  });
  test("without a map there are no numbers", () => {
    expect(list().rows.every((r) => r.number === null)).toBe(true);
  });
});

describe("keyboard", () => {
  test("ArrowDown and ArrowUp wrap", () => {
    expect(moveSelection(0, "ArrowDown", 3)).toBe(1);
    expect(moveSelection(2, "ArrowDown", 3)).toBe(0);
    expect(moveSelection(0, "ArrowUp", 3)).toBe(2);
  });
  test("with nothing selected, down picks the first and up the last", () => {
    expect(moveSelection(-1, "ArrowDown", 3)).toBe(0);
    expect(moveSelection(-1, "ArrowUp", 3)).toBe(2);
  });
  test("an empty list has no selection", () => {
    expect(moveSelection(0, "ArrowDown", 0)).toBe(-1);
  });
  test("Enter opens the selected row; an out-of-range index opens nothing", () => {
    const rows = list().rows;
    expect(pickRow(rows, 1)!.window.name).toBe("invoices");
    expect(pickRow(rows, -1)).toBeNull();
    expect(pickRow(rows, rows.length)).toBeNull();
  });
});
