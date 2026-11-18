import { describe, expect, it } from "bun:test";
import { newShowReads, needsRead, markPush, readStarted, readDone, READ_SOURCES, PANE_SAFETY_MS, type ShowReads, type ReadSource } from "../src/lib/paneReads.ts";

const SCOPE = "/w/orbit";
/** One show: reads what must be read, counts it, and records a good read. */
function show(s: ShowReads, now: number, counts: Record<string, number>, fail: ReadSource[] = []): void {
  for (const k of READ_SOURCES) {
    if (!needsRead(s, k, SCOPE, now)) continue;
    counts[k] = (counts[k] ?? 0) + 1;
    const t = readStarted(s, k);
    if (!fail.includes(k)) readDone(s, k, SCOPE, t, now);
  }
}

describe("pane reads on show", () => {
  it("10 hide/show cycles with no event: first show reads each source once, the rest 0", () => {
    const s = newShowReads(); const c: Record<string, number> = {};
    for (let i = 0; i < 10; i++) show(s, 1000 + i * 1000, c);
    for (const k of READ_SOURCES) expect(c[k]).toBe(1);
  });
  it("an event while hidden: 1 read on the next show, then quiet again", () => {
    const s = newShowReads(); const c: Record<string, number> = {};
    show(s, 1000, c);
    markPush(s, ["list"]);
    show(s, 2000, c); show(s, 3000, c);
    expect(c.list).toBe(2);
    expect(c.facets).toBe(1);
  });
  it("a failed read keeps the source dirty", () => {
    const s = newShowReads(); const c: Record<string, number> = {};
    show(s, 1000, c);
    markPush(s, ["list"]);
    show(s, 2000, c, ["list"]);
    show(s, 3000, c);
    expect(c.list).toBe(3);
    show(s, 4000, c);
    expect(c.list).toBe(3);
  });
  it("a push during a running read still counts as unseen", () => {
    const s = newShowReads();
    const t = readStarted(s, "list"); markPush(s, ["list"]); readDone(s, "list", SCOPE, t, 1000);
    expect(needsRead(s, "list", SCOPE, 1500)).toBe(true);
  });
  it("another scope reads; the safety window reads", () => {
    const s = newShowReads(); readDone(s, "facets", SCOPE, 0, 1000);
    expect(needsRead(s, "facets", "/w/other", 1100)).toBe(true);
    expect(needsRead(s, "facets", SCOPE, 1000 + PANE_SAFETY_MS)).toBe(true);
    expect(needsRead(s, "facets", SCOPE, 1000 + PANE_SAFETY_MS - 1)).toBe(false);
  });
});
