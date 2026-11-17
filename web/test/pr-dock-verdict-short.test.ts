import { describe, expect, test } from "bun:test";
import { dockVerdict } from "../src/lib/prGates.ts";

const base = { state: "OPEN" as const, isDraft: false, gates: [] };
describe("dockVerdict short", () => {
  test("a tight panel keeps a short word for the blockers count", () => {
    const need = (id: string) => ({ id, lead: id, mono: [], more: 0, rest: "", tone: "warn" as const });
    const c = dockVerdict({ ...base, reason: { kind: "blocked", text: "x" }, needs: [need("a"), need("b"), need("c")] as never });
    expect(c.label).toBe("3 things in the way");
    expect(c.short).toBe("3 blockers");
  });
  test("every other state has a short word too", () => {
    expect(dockVerdict({ ...base, reason: { kind: "ok", text: "x" } }).short).toBe("Ready");
    expect(dockVerdict({ ...base, state: "MERGED", reason: { kind: "closed", text: "x" } }).short).toBe("Merged");
    expect(dockVerdict({ ...base, isDraft: true, reason: { kind: "blocked", text: "x" } }).short).toBe("Draft");
  });
});
