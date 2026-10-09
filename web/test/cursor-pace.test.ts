/*
 * The editor-cursor poll in the peek pane rests when nobody is looking.
 *
 * It re-armed a 450 ms timer that asked nothing while the window was not
 * looked at: 8,000 wake-ups an hour for a pane nobody could see. The decision is
 * in `cursorDelay` so it can be run; the effect that uses it is asserted
 * against its source, because there is no DOM in these suites.
 */
import { describe, expect, test } from "bun:test";
import { CURSOR_MS, CURSOR_SLOW_MS, CURSOR_STILL, cursorDelay } from "../src/lib/cursorPace.ts";

describe("cursorDelay", () => {
  test("not looked at: no timer, whatever the cursor did", () => {
    expect(cursorDelay(false, 0)).toBeNull();
    expect(cursorDelay(false, CURSOR_STILL + 10)).toBeNull();
  });
  test("looked at and moving: the fast period", () => {
    expect(cursorDelay(true, 0)).toBe(CURSOR_MS);
    expect(cursorDelay(true, CURSOR_STILL - 1)).toBe(CURSOR_MS);
  });
  test("looked at and rested for five answers: 1.5 s", () => {
    expect(cursorDelay(true, CURSOR_STILL)).toBe(CURSOR_SLOW_MS);
    expect(CURSOR_SLOW_MS).toBe(1500);
  });
});

describe("the effect that asks nvim where the cursor is", () => {
  test("re-arms through cursorDelay, never on a bare timer, and wakes on focus and visibility", async () => {
    const text = await Bun.file(new URL("../src/components/PeekFile.tsx", import.meta.url)).text();
    const at = text.indexOf("api.editorWhere(editorId)");
    expect(at).toBeGreaterThan(0);
    const start = text.lastIndexOf("useEffect(() => {", at);
    const effect = text.slice(start, text.indexOf("}, [editorId]);", at))
      .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
    expect(effect).toContain("cursorDelay(looking(), still)");
    expect(effect).not.toMatch(/setTimeout\(ask, CURSOR/);
    expect(effect).toContain('addEventListener("focus", back)');
    expect(effect).toContain('addEventListener("visibilitychange", back)');
    expect(effect).toContain('removeEventListener("visibilitychange", back)');
  });
});
