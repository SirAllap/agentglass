import { describe, expect, test } from "bun:test";
import { back, canBack, canForward, forward, here, startHistory, visit } from "../src/lib/finderHistory.ts";
import { finderKey } from "../src/lib/finderKeys.ts";

const k = (key: string, o: Partial<{ ctrl: boolean; alt: boolean; shift: boolean }> = {}) =>
  finderKey({ key, ctrl: !!o.ctrl, meta: false, shift: !!o.shift, alt: !!o.alt }, { inField: false, hasSelection: false });

describe("history", () => {
  test("back and forward walk the places in order", () => {
    let h = startHistory("/a");
    h = visit(h, "/b"); h = visit(h, "/c");
    expect(here(h)).toBe("/c");
    h = back(h); expect(here(h)).toBe("/b");
    h = back(h); expect(here(h)).toBe("/a");
    expect(canBack(h)).toBe(false);
    expect(here(back(h))).toBe("/a");
    h = forward(h); h = forward(h);
    expect(here(h)).toBe("/c");
    expect(canForward(h)).toBe(false);
  });
  test("going somewhere new drops what was ahead, and the same place is not a step", () => {
    let h = visit(visit(startHistory("/a"), "/b"), "/c");
    h = back(back(h));
    h = visit(h, "/x");
    expect(h.stack).toEqual(["/a", "/x"]);
    expect(visit(h, "/x")).toBe(h);
  });
  test("it is capped so a long session does not grow without end", () => {
    let h = startHistory("/0");
    for (let i = 1; i < 500; i++) h = visit(h, `/${i}`);
    expect(h.stack.length).toBe(200);
    expect(here(h)).toBe("/499");
  });
});

describe("the keys", () => {
  test("Alt+Left and Alt+Right are back and forward, Alt+Up the parent, Alt+Home home", () => {
    expect(k("ArrowLeft", { alt: true })).toEqual({ t: "back" });
    expect(k("ArrowRight", { alt: true })).toEqual({ t: "forward" });
    expect(k("ArrowUp", { alt: true })).toEqual({ t: "up" });
    expect(k("Home", { alt: true })).toEqual({ t: "home" });
  });
  test("plain arrows still move, and other Alt chords are left alone", () => {
    expect(k("ArrowLeft")).toEqual({ t: "move", key: "ArrowLeft" });
    expect(k("x", { alt: true })).toBeNull();
  });
});
