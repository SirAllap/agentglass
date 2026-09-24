import { describe, expect, test, beforeAll } from "bun:test";
import { readFileSync } from "node:fs";
import type { PendingGate } from "../../shared/types.ts";

/*
 * Which live gate a bell row is about, so it can offer Allow/Deny instead of
 * only "↗ Open" — see TopBarNotes.tsx's HistoryRow.
 */

const cell = new Map<string, string>();
let gateForNote: typeof import("../src/lib/gateStore.ts")["gateForNote"];

beforeAll(async () => {
  (globalThis as any).localStorage = {
    getItem: (k: string) => cell.get(k) ?? null,
    setItem: (k: string, v: string) => { cell.set(k, v); },
    removeItem: (k: string) => { cell.delete(k); },
  };
  (globalThis as any).location = { hostname: "localhost", origin: "http://localhost:4000" };
  ({ gateForNote } = await import("../src/lib/gateStore.ts"));
});

const gate = (id: string, over: Partial<PendingGate> = {}): PendingGate => ({
  id, source_app: "claude", session_id: "abcdef0123456789",
  tool_name: "Bash", summary: "rm -rf build", created: 1_700_000_000_000, ...over,
});

describe("gateForNote", () => {
  test("a row keyed for a live gate finds it", () => {
    const gates = [gate("g1"), gate("g2")];
    expect(gateForNote({ key: "gate:g2" }, gates)).toBe(gates[1]!);
  });

  test("a row keyed for a gate that already resolved finds nothing", () => {
    expect(gateForNote({ key: "gate:gone" }, [gate("g1")])).toBeNull();
  });

  test("a row that is not about a gate at all carries no key", () => {
    expect(gateForNote({}, [gate("g1")])).toBeNull();
  });
});

/*
 * And the bell actually wires it up to answerGate — read between landmarks,
 * since there is no renderer in this project (CLAUDE.md).
 */
const bell = readFileSync(new URL("../src/components/TopBarNotes.tsx", import.meta.url), "utf8");
const between = (from: string, to: string): string => {
  const a = bell.indexOf(from);
  expect(a).toBeGreaterThan(-1);
  const b = bell.indexOf(to, a + from.length);
  expect(b).toBeGreaterThan(a);
  return bell.slice(a, b);
};

describe("the bell row calls answerGate, not just gateForNote", () => {
  test("HistoryRow wires the lookup to Allow/Deny", () => {
    const row = between("function HistoryRow(", "\nfunction laneCounts(");
    expect(row).toContain("gateForNote(");
    expect(row).toContain("answerGate(");
  });
});
