import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { railListKey, pinStillLanded, shouldRealign, scrollIsOurs } from "../src/components/settings/shell/PageRail.tsx";

const rail = readFileSync(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url), "utf8");

describe("a clicked rail entry stays current across a re-render", () => {
  test("a fresh array with the same sections keeps the key, so the pin is not reset", () => {
    const a = [{ id: "restore", title: "Restore", kind: "normal" as const }, { id: "danger", title: "Danger zone", kind: "danger" as const }];
    const b = a.map((s) => ({ ...s }));
    expect(b).not.toBe(a);
    expect(railListKey(b)).toBe(railListKey(a));
  });
  test("a different section list (a scope switch) changes the key, so the pin resets", () => {
    expect(railListKey([{ id: "limits" }, { id: "roles" }])).not.toBe(railListKey([{ id: "limits" }]));
    expect(railListKey([{ id: "a" }, { id: "b" }])).not.toBe(railListKey([{ id: "b" }, { id: "a" }]));
  });
  test("the spy effect keys on the ids, not on the sections array", () => {
    expect(rail).toContain("}, [listKey, scrollRoot, scopeKey]);");
    expect(rail).not.toContain("}, [sections, scrollRoot]);");
  });
});

describe("a pinned section does not fight the person's own scroll", () => {
  test("a pointer press (click, scrollbar drag) releases the pin", () => {
    expect(rail).toContain('["wheel", "touchstart", "keydown", "pointerdown"]');
  });
  test("realign only re-lands a section still near its landing spot", () => {
    expect(pinStillLanded(16, 0, 16)).toBe(true);
    expect(pinStillLanded(20, 0, 16)).toBe(true);
    expect(pinStillLanded(400, 0, 16)).toBe(false);
    expect(pinStillLanded(-300, 0, 16)).toBe(false);
    expect(rail).toContain("shouldRealign(pinned.current, foreignScroll.current");
  });
});

describe("the pin survives a growing page, and ends with the person's input", () => {
  test("jump, page grows 600 px, realign lands; pointerdown, grow, no realign", () => {
    let pinned = true;
    const foreign = false;
    // jump landed at 16; the page grows and the section drifts 600 px away: realign still lands it.
    expect(shouldRealign(pinned, foreign, 616, 0, 16)).toBe(true);
    // pointerdown releases the pin; growth afterwards does not realign.
    pinned = false;
    expect(shouldRealign(pinned, foreign, 1216, 0, 16)).toBe(false);
  });
  test("a scroll that was not ours keeps the distance test", () => {
    expect(shouldRealign(true, true, 616, 0, 16)).toBe(false);
    expect(shouldRealign(true, true, 18, 0, 16)).toBe(true);
  });
});

describe("settings.open page=about row=tutorial: the measured sequence", () => {
  // Real decision functions, the trace from headless Chrome: jump at t=0, scroll events every frame while it
  // smooth-scrolls, the realign cuts it short (its scrollend lands before its own scroll event), the page then
  // doubles. The section must keep being re-landed, never refused as "foreign".
  test("a late scroll event of our own realign is not foreign, so the next realign still lands", () => {
    let selfAt = 0, lastOursAt = -Infinity, foreign = false;
    const scroll = (t: number) => { if (scrollIsOurs(t, selfAt, lastOursAt)) lastOursAt = t; else foreign = true; };
    for (let t = 16; t <= 300; t += 16) scroll(t);            // the jump's smooth scroll, 112 px at t=300
    selfAt = 310;                                               // realign #1 (page grew to 996)
    scroll(340);                                                // its scroll event, after the jump's scrollend
    expect(foreign).toBe(false);
    selfAt = 1000;                                              // page doubled to 1984: section 1255 px down
    expect(shouldRealign(true, foreign, 1255 + 24, 24, 16)).toBe(true);
    scroll(1020);
    expect(foreign).toBe(false);
  });
  test("a scroll long after our last one is foreign, and then the distance test refuses a far section", () => {
    let foreign = false;
    if (!scrollIsOurs(2500, 1000, 1020)) foreign = true;
    expect(foreign).toBe(true);
    expect(shouldRealign(true, foreign, 1279, 24, 16)).toBe(false);
  });
  test("the rail watches the scroller and every section, not only the first child", () => {
    expect(rail).toContain("ro?.observe(root);");
  });
});
