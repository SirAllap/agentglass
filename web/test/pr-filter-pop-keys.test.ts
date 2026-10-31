import { describe, expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/PrFilterPop.tsx", import.meta.url)).text();
const bar = await Bun.file(new URL("../src/components/PrFilterBar.tsx", import.meta.url)).text();
const pins = await Bun.file(new URL("../src/components/PinList.tsx", import.meta.url)).text();
const pop = src.slice(src.indexOf("export function Pop("), src.indexOf("/** A mono caps heading"));
const code = pop.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*")).join("\n");

describe("the filter popover is reachable from the keyboard", () => {
  test("a popover without a typing input uses the shared focus-in, arrows and focus-back", () => {
    expect(code).toContain("usePopoverKeys(box, onClose, !keepFocus)");
  });
});

describe("the controls that take no focus have a key", () => {
  test("the search box pins, removes and clears the highlighted row, and follows the highlighted person", () => {
    expect(bar).toContain("focus!.pin(it.value)");
    expect(bar).toContain('e.key === "Delete"');
    expect(bar).toContain("focus.toggleFollow(flat[");
  });
  test("the unpin button inside the pins menu is a menu item, so the arrows reach it", () => {
    expect(pins).toMatch(/<button type="button" role="menuitem" tabIndex=\{-1\} onClick=\{\(\) => togglePin/);
  });
});
