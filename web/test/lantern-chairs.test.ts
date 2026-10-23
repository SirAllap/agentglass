/*
 * A CHAIR DRAWS ITS WORKERS UNDER IT; A WORKER STOPPED ON A PERSON NEVER HIDES THERE.
 *
 * The rule pulled out of the screen: which rows nest, which do not, and that
 * the numbers the header and the rail print are the same whether a worker is
 * nested or not. Then the two things the view must NOT do: ask for anything
 * of its own to show the chairs, and say "its orchestrator is gone" about a
 * worker whose chair is there. There is no renderer in this project, so those
 * two are asserted on the source and on the store's one request.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { nestUnderChairs } from "../src/lib/lanternChairs.ts";
import { __setLanternRows, groupLantern, lanternChairs, lanternNeed, refreshLantern } from "../src/lib/lanternStore.ts";
import { api } from "../src/lib/api.ts";
import type { LanternRow } from "../src/components/LanternView.tsx";

const ROOT = "/home/a/code/orbit";
const row = (name: string, over: Partial<LanternRow> = {}): LanternRow => ({ name, from: "seen", state: "working", paneId: `%${name}`, ...over });
const chair = (over: Partial<LanternRow> = {}) => row("orchestrator-abc", { role: "orchestrator", chairOf: ROOT, ...over });
const worker = (name: string, over: Partial<LanternRow> = {}) => row(name, { under: ROOT, ...over });
const needs = (kind: "permission" | "input" | "gate" = "permission") => ({ kind, why: "run the tests", since: 1 });

afterAll(() => __setLanternRows(null));

describe("nesting", () => {
  test("a worker that has gone stays with the gone ones, not in its chair's fold", () => {
    const { chairs, rest } = nestUnderChairs([chair(), worker("builder-1"), worker("scout-1", { gone: true })]);
    expect(chairs[0]!.workers.map((w) => w.name)).toEqual(["builder-1"]);
    expect(rest.map((r) => r.name)).toEqual(["scout-1"]);
  });

  test("a worker is drawn under the chair it answers to, and the chair is not drawn twice", () => {
    const { chairs, rest } = nestUnderChairs([chair(), worker("builder-1"), worker("scout-1", { state: "idle" }), row("review-1042")]);
    expect(chairs).toHaveLength(1);
    expect(chairs[0]!.workers.map((w) => w.name)).toEqual(["builder-1", "scout-1"]);
    expect(rest.map((r) => r.name)).toEqual(["review-1042"]);
  });

  test("a worker stopped on a person stays out of the fold, and the chair says so", () => {
    const { chairs, rest } = nestUnderChairs([
      chair(), worker("builder-1", { state: "waiting", needsYou: needs() }), worker("builder-2", { state: "waiting", needsYou: needs("input") }), worker("builder-3"),
    ]);
    expect(rest.map((r) => r.name)).toEqual(["builder-1", "builder-2"]);
    expect(chairs[0]!.workers.map((w) => w.name)).toEqual(["builder-3"]);
    expect(chairs[0]!.above).toBe(2);
  });

  test("an orphan, and a worker of a chair that is not on the board, stay at the top level", () => {
    const { chairs, rest } = nestUnderChairs([chair(), row("builder-9", { orphaned: true }), row("builder-8", { under: "/home/a/code/other" })]);
    expect(chairs[0]!.workers).toEqual([]);
    expect(rest.map((r) => r.name)).toEqual(["builder-9", "builder-8"]);
  });

  test("no chair, no nesting: the board is exactly what it was", () => {
    const rows = [row("a"), row("b", { under: ROOT })];
    expect(nestUnderChairs(rows)).toEqual({ chairs: [], rest: rows });
  });
});

describe("the counts do not move", () => {
  test("a nested worker that needs a person is in the same number as an un-nested one", () => {
    const rows = [chair(), worker("builder-1", { state: "waiting", needsYou: needs() }), worker("builder-2")];
    expect(groupLantern(nestUnderChairs(rows).rest).need.map((r) => r.name)).toEqual(["builder-1"]);
    __setLanternRows(rows);
    expect(lanternNeed()).toBe(1);
  });
});

describe("the view asks for nothing new", () => {
  test("the chairs ride on the board's one answer", async () => {
    const real = api.agentBoard;
    let calls = 0;
    api.agentBoard = (async () => {
      calls++;
      return { ok: true, agents: [chair()], chairs: [{ root: ROOT, name: "orchestrator-abc", kind: "claude", model: "opus", next: { engine: "opencode", model: "big-pickle" }, handedOff: false }] };
    }) as typeof api.agentBoard;
    try {
      await refreshLantern();
      expect(calls).toBe(1);
      expect(lanternChairs().map((c) => c.root)).toEqual([ROOT]);
    } finally { api.agentBoard = real; __setLanternRows(null); }
  });

  test("the view has the same two clocks it had and no call of its own for the chairs", async () => {
    const src = await Bun.file(new URL("../src/components/LanternView.tsx", import.meta.url)).text();
    const view = src.slice(src.indexOf("export function LanternView("));
    expect((view.match(/setInterval\(/g) ?? []).length).toBe(2);
    expect(view).not.toContain("api.seat(");
    const block = src.slice(src.indexOf("function ChairBlock("), src.indexOf("export function LanternView("));
    expect(block).not.toMatch(/setInterval|setTimeout|useEffect/);
    expect(block.match(/api\.\w+/g)).toEqual(["api.seatChange"]);
  });

  test("a chair that is in its seat is never told its orchestrator is gone", async () => {
    const src = await Bun.file(new URL("../src/components/LanternView.tsx", import.meta.url)).text();
    expect(src).toContain("r.orphaned && ");
    expect(src).toContain("its orchestrator is gone");
  });
});
