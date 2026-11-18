import { describe, expect, test } from "bun:test";
import { blockerWords } from "../src/lib/blockers.ts";
import { tileAction, tileHeader } from "../src/lib/jiraTileModel.ts";

const b = (key: string, status: string) => ({ key, status });
const A = b("ORBIT-1785", "Code review"), B = b("ORBIT-1711", "In development"), C = b("ORBIT-1600", "Backlog");

describe("blocker wording", () => {
  test("0 blockers: nothing", () => {
    expect(blockerWords([])).toBeNull();
    expect(tileHeader({ blockedBy: [], worker: false, prs: [] }).kind).toBe("quiet");
  });
  test("1 blocker: unchanged text", () => {
    const w = blockerWords([A])!;
    expect(w.chip).toBe("Blocked by ORBIT-1785 (Code review) - don't merge alone");
    expect(w.short).toBe("Blocked by ORBIT-1785");
    expect(tileAction({ blockedBy: [A], worker: false, header: "blocked", nextStatus: null, writable: true }).primary).toMatchObject({ label: "Open ORBIT-1785" });
  });
  test("2 blockers: counts both", () => {
    const w = blockerWords([A, B])!;
    expect(w.chip).toBe("Blocked by ORBIT-1785 and 1 more - don't merge alone");
    expect(w.short).toBe("Blocked by 2 cards");
    expect(w.tip).toBe("ORBIT-1785 (Code review), ORBIT-1711 (In development)");
    expect(tileHeader({ blockedBy: [A, B], worker: false, prs: [] })).toMatchObject({ kind: "blocked", text: "Blocked by 2 cards" });
    const p = tileAction({ blockedBy: [A, B], worker: false, header: "blocked", nextStatus: null, writable: true }).primary!;
    expect(p.label).toBe("Open ORBIT-1785");
  });
  test("3 blockers", () => {
    const w = blockerWords([A, B, C])!;
    expect(w.chip).toBe("Blocked by ORBIT-1785 and 2 more - don't merge alone");
    expect(w.short).toBe("Blocked by 3 cards");
    expect(w.tip).toContain("ORBIT-1600 (Backlog)");
  });
  test("bare keys still work", () => {
    expect(blockerWords(["ORBIT-1", "ORBIT-2"])!.tip).toBe("ORBIT-1, ORBIT-2");
  });
});
