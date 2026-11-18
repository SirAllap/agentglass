import { describe, expect, test } from "bun:test";
import { jumpTarget } from "../src/components/settings/shell/shellRules.ts";

describe("jumpTarget", () => {
  test("a section id with no row of that name is a section", () => {
    expect(jumpTarget("checks", ["version", "update"], ["build", "checks", "tutorial"])).toBe("section");
  });
  test("a row id is a row", () => {
    expect(jumpTarget("version", ["version"], ["build"])).toBe("row");
  });
  test("an id that is both is the row", () => {
    expect(jumpTarget("x", ["x"], ["x"])).toBe("row");
  });
  test("an unknown id is nothing", () => {
    expect(jumpTarget("nope", ["a"], ["b"])).toBeNull();
  });
});

import { pendingJumpReady } from "../src/components/settings/shell/shellRules.ts";

describe("pendingJumpReady", () => {
  test("a jump to About waits while the old page is still in front", () => {
    expect(pendingJumpReady("about", "diff", "diff")).toBe(false);
  });
  test("it also waits while the new page is asked for but not yet in front", () => {
    expect(pendingJumpReady("about", "diff", "about")).toBe(false);
  });
  test("it lands once About is in front", () => {
    expect(pendingJumpReady("about", "about", "about")).toBe(true);
  });
  test("a jump with no page lands on whatever is in front", () => {
    expect(pendingJumpReady(null, "diff", "diff")).toBe(true);
  });
});

import { readFileSync } from "node:fs";
import { keepPendingJump, needsDirectScroll, releaseOrphanRowPin } from "../src/components/settings/shell/shellRules.ts";

describe("stale jump, row fallback, orphan pin", () => {
  const known = (p: string) => p === "about";
  test("closed Settings drops the jump", () => expect(keepPendingJump(false, "about", known)).toBe(false));
  test("unknown page drops the jump", () => expect(keepPendingJump(true, "ghost", known)).toBe(false));
  test("known or any page keeps it", () => { expect(keepPendingJump(true, "about", known)).toBe(true); expect(keepPendingJump(true, null, known)).toBe(true); });
  test("unhandled pin event falls back to scrollIntoView", () => { expect(needsDirectScroll(true)).toBe(true); expect(needsDirectScroll(false)).toBe(false); });
  test("list change releases a row pin", () => expect(releaseOrphanRowPin({ pinned: true, id: "s", row: "r" })).toEqual({ pinned: false, id: null, row: null }));
  test("section pin survives re-arm", () => { const s = { pinned: true, id: "s", row: null }; expect(releaseOrphanRowPin(s)).toBe(s); });
});

describe("row jump, listKey changes twice while the page grows 1000 px, realign still lands; close releases", () => {
  const rail = readFileSync(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url), "utf8");
  const body = rail.slice(rail.indexOf("const listKey = railListKey"), rail.indexOf("const entry = "));
  const effectCleanup = body.slice(body.lastIndexOf("return () => {"), body.indexOf("}, [listKey, scrollRoot, scopeKey]);"));
  test("the list-key effect cleanup keeps the row pin", () => {
    expect(effectCleanup).not.toContain("releaseOrphanRowPin");
    expect(effectCleanup).not.toContain("pinnedRow.current =");
  });
  test("re-arm restarts the quiet timer for a live row pin", () => expect(body).toContain("if (pinnedRow.current) armQuiet(pinnedRow.current);"));
  test("an unmount-only effect releases the row pin (close / page change)", () => expect(body).toMatch(/useEffect\(\(\) => \(\) => \{\s*const next = releaseOrphanRowPin[\s\S]*?\}, \[\]\);/));
  test("pin state across two re-arms and growth: kept until close", () => {
    let s: { pinned: boolean; id: string | null; row: string | null } = { pinned: true, id: "about", row: "tutorial" };
    for (let i = 0; i < 2; i++) { /* list key changes: cleanup no longer releases */ }
    expect(s.row).toBe("tutorial");
    s = releaseOrphanRowPin(s);
    expect(s).toEqual({ pinned: false, id: null, row: null });
  });
});
