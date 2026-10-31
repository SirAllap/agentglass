/*
 * Closing the bench with its chord left the keyboard on the page: the focus
 * inside the window was blurred and nothing gave it back, so the next key
 * needed a click. The decision is a pure function; the effect that calls it is
 * pinned as source, because xterm needs a DOM that `bun test` does not have.
 */
import { describe, expect, test } from "bun:test";
import { focusToRemember, focusToRestore } from "../src/lib/benchFocus.ts";

const live = { isConnected: true, id: "live" };
const gone = { isConnected: false, id: "gone" };
const other = { isConnected: true, id: "other" };

describe("focusToRemember", () => {
  test("keeps a live element outside the bench", () => expect(focusToRemember(live, false, false)).toBe(live));
  test("drops the page itself, the bench, and nothing", () => {
    expect(focusToRemember(live, true, false)).toBeNull();
    expect(focusToRemember(live, false, true)).toBeNull();
    expect(focusToRemember(null, false, false)).toBeNull();
    expect(focusToRemember(gone, false, false)).toBeNull();
  });
});

describe("focusToRestore", () => {
  test("gives back the remembered element when focus is lost", () => expect(focusToRestore(live, other, true)).toBe(live));
  test("falls back when the remembered one was unmounted, or none was kept", () => {
    expect(focusToRestore(gone, other, true)).toBe(other);
    expect(focusToRestore(null, other, true)).toBe(other);
  });
  test("leaves focus where the person put it", () => expect(focusToRestore(live, other, false)).toBeNull());
});

describe("FloatingBench close effect", async () => {
  const src = await Bun.file(new URL("../src/components/bench/FloatingBench.tsx", import.meta.url)).text();
  const start = src.indexOf("const refuse = (e: FocusEvent)");
  const body = src.slice(start, src.indexOf("return () => el.removeEventListener", start));
  test("remembers on open and restores after the blur, with the refuse guard kept", () => {
    expect(src).toContain("cameFrom.current = focusToRemember(");
    expect(body).toContain('el.addEventListener("focusin", refuse)');
    expect(body.indexOf("focusToRestore(")).toBeGreaterThan(body.indexOf('addEventListener("focusin"'));
    expect(body).toContain("back?.focus(");
  });
});
