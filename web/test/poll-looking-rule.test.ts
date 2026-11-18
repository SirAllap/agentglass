import { describe, expect, test } from "bun:test";
import { isLooking, shouldPollNow } from "../src/lib/usePoll.ts";

describe("poll pause rule", () => {
  test("runs whenever visible; focus is not part of it", () => {
    expect(isLooking(false)).toBe(true);
    expect(isLooking(true)).toBe(false);
  });
  test("lanternStore and prBehindStore use the one definition", async () => {
    for (const f of ["lanternStore", "prBehindStore"]) {
      const src = await Bun.file(new URL(`../src/lib/${f}.ts`, import.meta.url)).text();
      expect(src).toContain("isLooking(document.hidden)");
      expect(src).not.toContain("hasFocus");
    }
  });
  test("catches up once, on the return edge only", () => {
    expect(shouldPollNow(false, true)).toBe(true);
    expect(shouldPollNow(true, true)).toBe(false);
    expect(shouldPollNow(false, false)).toBe(false);
    expect(shouldPollNow(true, false)).toBe(false);
  });
});

describe("idle flag on the root", () => {
  test("is 1 (freeze loops) only while hidden", async () => {
    const { idleFlag } = await import("../src/lib/usePoll.ts");
    expect(idleFlag(false)).toBe("0");
    expect(idleFlag(true)).toBe("1");
  });
  test("the stylesheet pauses every animation under data-idle, and useLive sets it from the rule", async () => {
    const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
    expect(css).toMatch(/:root\[data-idle="1"\] :not\(#ag-cover, #ag-cover \*\)\s*,[\s\S]*?animation-play-state: paused !important/);
    const live = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text();
    expect(live).toContain("dataset.idle = idleFlag(document.hidden)");
  });
});
