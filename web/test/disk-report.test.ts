// The report's grouping and wording on the client: the verdicts the engine gave
// decide the groups, a line it did not cover keeps the scan's own place, and the
// estimate never quotes dollars before the engine has said them.
import { afterAll, describe, expect, test } from "bun:test";
import { globalStubs } from "./stubGlobal.ts";
import type { DiskCleanLine, DiskExplain } from "../../shared/types.ts";

const stubGlobal = globalStubs();
const store = new Map<string, string>();
stubGlobal("localStorage", {
  getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k), clear: () => store.clear(), key: () => null, length: 0,
} as unknown as Storage);
stubGlobal("location", new URL("http://localhost:5173/"));
stubGlobal("window", new EventTarget());
afterAll(() => store.clear());

const { explainEstimate, explainSpent, reportGroups } = await import("../src/lib/diskClean.ts");

const line = (id: string, bytes: number, verdict: DiskCleanLine["verdict"] = "safe"): DiskCleanLine =>
  ({ id, kind: "package-cache", mount: "/", label: id, bytes, verdict, why: "scan says", target: null });
const ex = (items: DiskExplain["items"]): DiskExplain => ({ status: "ready", scanAt: 1, startedAt: 1, count: items?.length ?? 0, estIn: 14000, estOut: 4000, items });

describe("reportGroups", () => {
  const lines = [line("a", 5), line("b", 9), line("c", 2, "ask"), line("d", 7, "explain"), line("e", 1)];
  const g = reportGroups(lines, ex([
    { id: "a", verdict: "safe", why: "w", regen: "r" }, { id: "b", verdict: "safe", why: "w", regen: "r" },
    { id: "c", verdict: "check", why: "w", regen: "r" }, { id: "e", verdict: "keep", why: "w", regen: "r" },
  ]));
  test("groups by the engine's verdict, biggest first, with sizes", () => {
    expect(g.safe.rows.map((x) => x.line.id)).toEqual(["b", "a"]);
    expect(g.safe.bytes).toBe(14);
    expect(g.check.rows.map((x) => x.line.id)).toEqual(["c"]);
    expect(g.keep.rows.map((x) => x.line.id)).toEqual(["e"]);
  });
  test("a line the report did not cover stays out of every verdict group", () => {
    expect(g.rest.map((l) => l.id)).toEqual(["d"]);
  });
  test("no report: nothing is grouped", () => {
    const n = reportGroups(lines, undefined);
    expect(n.safe.rows.length + n.check.rows.length + n.keep.rows.length).toBe(0);
    expect(n.rest.length).toBe(5);
  });
});

describe("wording", () => {
  test("the estimate is in tokens", () => {
    expect(explainEstimate({ count: 9, estIn: 14000, estOut: 4000 })).toBe("9 items · est. 14k tokens in, 4k out");
    expect(explainEstimate({ count: 1, estIn: 800, estOut: 70 })).toBe("1 item · est. 800 tokens in, 70 out");
  });
  test("dollars appear only once the engine reported them", () => {
    expect(explainSpent({})).toBeNull();
    expect(explainSpent({ costUsd: 0.0042 })).toBe("$0.004");
    expect(explainSpent({ costUsd: 0.06 })).toBe("$0.06");
  });
});
