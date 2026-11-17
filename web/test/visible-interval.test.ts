import { describe, expect, test } from "bun:test";
import { shouldRun, shouldCatchUp, intervalWhileVisible } from "../src/lib/visibleInterval.ts";
import { globalStubs } from "./stubGlobal.ts";

const stubGlobal = globalStubs();

// A manual clock: `advance(ms)` fires every live interval whose period has passed.
function fakeClock() {
  let now = 0, next = 1;
  const live = new Map<number, { fn: () => void; ms: number; due: number }>();
  stubGlobal("setInterval", (fn: () => void, ms: number) => { const id = next++; live.set(id, { fn, ms, due: now + ms }); return id; });
  stubGlobal("clearInterval", (id: number) => { live.delete(id); });
  return {
    advance(ms: number) {
      const end = now + ms;
      while (true) {
        const due = [...live.values()].filter((t) => t.due <= end).sort((a, b) => a.due - b.due)[0];
        if (!due) break;
        now = due.due; due.due += due.ms; due.fn();
      }
      now = end;
    },
    count: () => live.size,
  };
}
function fakeDocument(hidden: boolean) {
  const l = new Set<() => void>();
  const doc = {
    hidden,
    addEventListener: (_: string, f: () => void) => { l.add(f); },
    removeEventListener: (_: string, f: () => void) => { l.delete(f); },
    flip(h: boolean) { doc.hidden = h; for (const f of [...l]) f(); },
  };
  stubGlobal("document", doc);
  return doc;
}

describe("intervalWhileVisible", () => {
  test("hidden: 0 ticks and no timer over 10 periods", () => {
    const clock = fakeClock(); fakeDocument(true);
    let n = 0;
    const stop = intervalWhileVisible(() => { n++; }, 1000);
    clock.advance(10_000);
    expect(n).toBe(0);
    expect(clock.count()).toBe(0);
    stop();
  });
  test("visible: 10 ticks over 10 periods", () => {
    const clock = fakeClock(); fakeDocument(false);
    let n = 0;
    const stop = intervalWhileVisible(() => { n++; }, 1000);
    clock.advance(10_000);
    expect(n).toBe(10);
    stop();
    expect(clock.count()).toBe(0);
  });
  test("hiding stops it, showing again catches up once and resumes", () => {
    const clock = fakeClock(); const doc = fakeDocument(false);
    let n = 0;
    const stop = intervalWhileVisible(() => { n++; }, 1000);
    clock.advance(3000); doc.flip(true); clock.advance(10_000);
    expect(n).toBe(3);
    doc.flip(false); expect(n).toBe(4);
    clock.advance(2000); expect(n).toBe(6);
    stop();
  });
});


describe("visible interval decisions", () => {
  test("runs only when the view is active and the document is visible", () => {
    expect(shouldRun(true, false)).toBe(true);
    expect(shouldRun(true, true)).toBe(false);
    expect(shouldRun(false, false)).toBe(false);
  });
  test("catches up once, on the edge from paused to running", () => {
    expect(shouldCatchUp(false, true)).toBe(true);
    expect(shouldCatchUp(true, true)).toBe(false);
    expect(shouldCatchUp(true, false)).toBe(false);
    expect(shouldCatchUp(false, false)).toBe(false);
  });
});

describe("the ask safety net", () => {
  test("is a visible-only 60 s re-check under the push frame", async () => {
    const t = await Bun.file(new URL("../src/lib/settingsRequests.ts", import.meta.url)).text();
    expect(t).toContain("export const SAFETY_MS = 60_000;");
    expect(t).toContain("intervalWhileVisible(");
    const live = await Bun.file(new URL("../src/lib/useLive.ts", import.meta.url)).text();
    expect(live).toMatch(/frame\.type === "initial"\) \{[\s\S]{0,400}settingsRequestsChanged\(\)/);
  });
});
