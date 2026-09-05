/*
 * The keys inside the palette's menus belong to the menu.
 *
 * This is a source-shape test, which is the honest thing to say about it: the
 * menus render through a Portal, and a Portal needs a document that `bun test`
 * does not have — so the behaviour itself was measured by driving the built app
 * (Ctrl+Shift+P, open the checkout chip, press ⇥ / ↑↓ / ⏎) and what is pinned
 * here is the seam that fixed it.
 *
 * What it is guarding against is worth spelling out, because the bug reads as
 * impossible from the code: a React portal bubbles its events through the REACT
 * tree, not the DOM one. So with the checkout menu open, every key also reached
 * the palette's own handler — ⇥ switched the tab underneath, ↑↓ walked a cursor
 * hidden behind the menu, and ⏎ opened the highlighted result. Measured: nvim
 * came up on a file behind the menu that was supposed to have the keys.
 *
 * The other half is focus: `autoFocus` does not take when a field mounts while
 * another one holds focus, which is always the case here — the palette focuses
 * its search box and keeps it. So the menu's filter never had the caret and
 * what you typed went into the search behind it.
 */
import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/FilePalette.tsx", import.meta.url)).text();

/** Every menu in this file is a `<Portal z={LAYER.menu}>`, so the count is
 *  taken from the source rather than written down: a fifth chip must not be
 *  able to arrive without a handler and still pass. */
const menus = src.match(/<Portal z=\{LAYER\.menu\}>/g)?.length ?? 0;
const guarded = src.match(/onKeyDown=\{menuKeys\(/g)?.length ?? 0;
const fields = src.match(/useMenuField\(open\)/g)?.length ?? 0;

describe("a menu takes its own keys", () => {
  test("there are menus to guard", () => {
    expect(menus).toBeGreaterThan(0);
  });

  test("every one of them is guarded", () => {
    expect(guarded).toBe(menus);
  });

  test("the guard is a real stop, not a filtered one", () => {
    // `stopPropagation` behind an `if` was the state that shipped: Escape was
    // stopped and every other key went through.
    const fn = src.slice(src.indexOf("const menuKeys ="), src.indexOf("function useMenuField"));
    expect(fn).toContain("e.stopPropagation();");
    expect(fn.indexOf("e.stopPropagation();")).toBeLessThan(fn.indexOf("if ("));
    expect(fn).toContain("Escape");
  });
});

describe("a menu's field takes its own focus", () => {
  test("one per menu", () => {
    expect(fields).toBe(menus);
  });

  test("nothing in here relies on autoFocus any more", () => {
    // Measured, not assumed: it does not take inside a Portal that opens while
    // the palette's search box is focused. The prose above may name it; a JSX
    // attribute is what this looks for.
    expect(src.match(/autoFocus(?=[\s>/])/g)).toBe(null);
  });

  test("the focus is deferred, because the panel may still be animating", () => {
    const hook = src.slice(src.indexOf("function useMenuField"), src.indexOf("export function FilePalette"));
    expect(hook).toContain("setTimeout");
    expect(hook).toContain("ref.current?.focus()");
  });
});
