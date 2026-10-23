/*
 * The board is driven with the mouse: lanes sort, fold from their whole title
 * bar, and remember how they were left. The wiring is read from source (an
 * event handler does not run under renderToStaticMarkup); the pure parts run.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { globalStubs } from "./stubGlobal";
import type { PrSummary } from "../../shared/types.ts";
const stubGlobal = globalStubs();

const cell = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => cell.get(k) ?? null,
  setItem: (k: string, v: string) => { cell.set(k, String(v)); },
  removeItem: (k: string) => { cell.delete(k); },
});

const { sortCards, SORT_KEYS } = await import("../src/lib/prSort.ts");
const { laneSorts, setLaneSorts, boardScroll, setBoardScroll } = await import("../src/lib/boardPrefs.ts");

const pr = (number: number, o: Partial<PrSummary> = {}): PrSummary => ({
  number, title: `t${number}`, updatedAt: "2026-10-10T00:00:00Z", additions: 1, deletions: 1,
  checks: { failure: 0, failing: [] }, ...o,
} as unknown as PrSummary);
const nums = (l: readonly PrSummary[]) => l.map((p) => p.number);

describe("sortCards", () => {
  const list = [
    pr(1, { updatedAt: "2026-10-12T00:00:00Z", additions: 5, deletions: 5 }),
    pr(2, { updatedAt: "2026-10-01T00:00:00Z", additions: 90, deletions: 10, checks: { failure: 2, failing: [] } as never }),
    pr(3, { updatedAt: "2026-10-20T00:00:00Z", additions: 1, deletions: 1, checks: { failure: 5, failing: [] } as never }),
    pr(4, { updatedAt: "2026-10-01T00:00:00Z", additions: 5, deletions: 5 }),
  ];

  test("default is the filed order, untouched", () => {
    expect(sortCards(list, "default")).toBe(list);
  });
  test("oldest and newest go by last update", () => {
    expect(nums(sortCards(list, "oldest"))).toEqual([2, 4, 1, 3]);
    expect(nums(sortCards(list, "newest"))).toEqual([3, 1, 2, 4]);
  });
  test("biggest diff and most failing checks", () => {
    expect(nums(sortCards(list, "diff"))).toEqual([2, 1, 4, 3]);
    expect(nums(sortCards(list, "failing"))).toEqual([3, 2, 1, 4]);
  });
  test("stable: ties keep the filed order, and the input is not mutated", () => {
    const before = nums(list);
    expect(nums(sortCards(list, "oldest")).slice(0, 2)).toEqual([2, 4]);
    expect(nums(list)).toEqual(before);
  });
  test("an unreadable date sorts as the oldest instead of throwing", () => {
    expect(nums(sortCards([pr(1), pr(2, { updatedAt: "nope" })], "oldest"))).toEqual([2, 1]);
  });
});

describe("what the board remembers", () => {
  test("lane sorts round trip; the default is never written", () => {
    setLaneSorts({ review: "oldest", blocked: "default" });
    expect(JSON.parse(cell.get("agentglass.pr.laneSort")!)).toEqual({ review: "oldest" });
    expect(laneSorts(["review", "blocked"])).toEqual({ review: "oldest" });
    setLaneSorts({ review: "default" });
    expect(cell.has("agentglass.pr.laneSort")).toBe(false);
  });
  test("a lane that no longer exists, or a key nobody knows, is dropped", () => {
    cell.set("agentglass.pr.laneSort", JSON.stringify({ gone: "oldest", review: "sideways", ready: "diff" }));
    expect(laneSorts(["review", "ready"])).toEqual({ ready: "diff" });
    cell.set("agentglass.pr.laneSort", "not json");
    expect(laneSorts(["review"])).toEqual({});
  });
  test("scroll round trips per repository and clears at the origin", () => {
    setBoardScroll("acme/orbit", { x: 640, lanes: { review: 220, ready: 0 } });
    expect(boardScroll("acme/orbit")).toEqual({ x: 640, lanes: { review: 220 } });
    expect(boardScroll("acme/other")).toEqual({ x: 0, lanes: {} });
    setBoardScroll("acme/orbit", { x: 0, lanes: {} });
    expect(cell.has("agentglass.pr.scroll.acme/orbit")).toBe(false);
  });
  test("garbage in storage reads as the start", () => {
    cell.set("agentglass.pr.scroll.acme/orbit", '{"x":"far","lanes":7}');
    expect(boardScroll("acme/orbit")).toEqual({ x: 0, lanes: {} });
  });
  test("every sort key has a label", () => {
    expect(SORT_KEYS.length).toBe(5);
  });
});

describe("the board's wiring", () => {
  const SRC = readFileSync(new URL("../src/components/TriageBoard.tsx", import.meta.url), "utf8");
  const bare = SRC.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const at = bare.indexOf("<h3 onClick");
  const heading = bare.slice(at, bare.indexOf("</h3>", at));

  test("the whole title bar folds, and only when the lane may fold", () => {
    expect(heading).toContain("onClick={canFold ? () => toggleFold(l.id, all.length) : undefined}");
    expect(heading).toContain("agx-lane-bar");
  });
  test("the info icon, the sort control and the arrow do not fold twice", () => {
    expect(heading).toMatch(/role="note" onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(heading).toMatch(/<select[\s\S]*?onClick=\{\(e\) => e\.stopPropagation\(\)\}/);
    expect(heading).toMatch(/e\.stopPropagation\(\); toggleFold\(/);
  });
  test("the folded strip unfolds the same way, in the lane's colour", () => {
    expect(bare).toMatch(/agx-lane-bar"\s*\n?\s*style=\{\{ color: l\.tint, "--lane": l\.tint \}/);
  });
  test("the hover wash is the lane's own colour", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.agx-lane-bar:hover \{ background: color-mix\(in srgb, var\(--lane\)/);
  });
  test("the sort control is in every open lane, in one place", () => {
    expect(heading).toContain("data-sort={l.id}");
    expect(heading).not.toMatch(/\{canFold && \(\s*<select/);
  });
  test("scroll is restored once and written back from both scrollers", () => {
    expect(bare).toContain("boardScroll(scrollKey)");
    expect(bare).toContain("onScroll={remember}");
    expect(bare.match(/onScroll=\{remember\}/g)!.length).toBe(2);
  });
});
