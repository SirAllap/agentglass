/*
 * A selection that is passing through is not previewed.
 *
 * What went wrong: holding an arrow key down a folder of 22 screenshots read
 * the facts of every one and mounted its picture, a whole 0.6 MB file decoded
 * at up to 5 megapixels, each thrown away by the next key repeat.
 */
import { describe, expect, test } from "bun:test";
import { PREVIEW_SETTLE_MS, previewWait } from "../src/lib/finderPreview.ts";

const look = await Bun.file(new URL("../src/components/finder/machine/QuickLook.tsx", import.meta.url)).text();
const apiSrc = await Bun.file(new URL("../src/lib/api.ts", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => { const t = l.trim(); return !t.startsWith("//") && !t.startsWith("*") && !t.startsWith("/*"); }).join("\n");

describe("how long a selection waits", () => {
  test("a click, or the first key, is read at once", () => {
    expect(previewWait(Date.now())).toBe(0);
    expect(previewWait(PREVIEW_SETTLE_MS)).toBe(0);
    expect(previewWait(5_000)).toBe(0);
  });
  test("one that follows another within a key repeat waits for the key to be let go", () => {
    expect(previewWait(0)).toBe(PREVIEW_SETTLE_MS);
    expect(previewWait(33)).toBe(PREVIEW_SETTLE_MS);
    expect(previewWait(PREVIEW_SETTLE_MS - 1)).toBe(PREVIEW_SETTLE_MS);
  });
  test("a clock that went backwards holds nothing back", () => {
    expect(previewWait(-40)).toBe(0);
  });
  test("the wait is longer than a key repeat and shorter than a person notices", () => {
    expect(PREVIEW_SETTLE_MS).toBeGreaterThan(40);
    expect(PREVIEW_SETTLE_MS).toBeLessThanOrEqual(150);
  });
});

describe("the preview pane's wiring", () => {
  const c = code(look);
  test("the read is timed by previewWait, and a selection that leaves cancels both the timer and the request", () => {
    expect(c).toContain("const wait = previewWait(now - picked.current);");
    expect(c).toContain("const timer = wait ? setTimeout(read, wait) : null;");
    expect(c).toContain("api.previewFacts(path, leave.signal)");
    expect(c).toContain("return () => { leave.abort(); if (timer) clearTimeout(timer); };");
  });
  test("the time of the last selection is noted even when that one had no preview", () => {
    expect(c.indexOf("picked.current = now;")).toBeGreaterThan(-1);
    expect(c.indexOf("picked.current = now;")).toBeLessThan(c.indexOf("if (!path || !row || folder || row.locked || gated) return;"));
  });
  test("the facts request takes the signal", () => {
    expect(code(apiSrc)).toContain("previewFacts: (path: string, signal?: AbortSignal) => get<FileFacts>(`/preview/facts?path=${encodeURIComponent(path)}`, signal),");
  });
});
