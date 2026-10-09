/*
 * A menu opened from a clickable row must not click the row.
 *
 * A portal moves the DOM, not the React tree: an event inside the menu still
 * bubbles to the component that rendered it. Measured with real input in headless
 * Chrome on a row that opens a card on click and a menu on right-click:
 *
 *   click "Copy card URL"        -> [copy-url, row-click]
 *   Enter on a focused item      -> [row-enter, copy-url, row-click]
 *   click on the dismiss catcher -> the row saw a mousedown
 *
 * After the fix: [copy-url], [copy-url], and the catcher's click ends at the
 * catcher. The decision is in lib/menuEvents.ts and asserted here without a
 * DOM; the wiring is asserted against the source of the one menu component.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MENU_ACTIVATION_KEYS, MENU_POINTER_EVENTS, menuEventGuards, swallowsKey } from "../src/lib/menuEvents.ts";

const spy = (key = "") => {
  let stopped = 0;
  return { e: { key, stopPropagation: () => { stopped++; } }, get stopped() { return stopped; } };
};

describe("what a menu keeps from the row that opened it", () => {
  const guards = menuEventGuards();

  it("stops every pointer and touch event, so a click on an item is not also a click on the row", () => {
    for (const name of MENU_POINTER_EVENTS) {
      const s = spy();
      (guards[name] as (e: unknown) => void)(s.e);
      expect(s.stopped, name).toBe(1);
    }
    // the ones the bug was measured on, named so a rename cannot drop them
    expect(MENU_POINTER_EVENTS).toContain("onClick");
    expect(MENU_POINTER_EVENTS).toContain("onMouseDown");
    expect(MENU_POINTER_EVENTS).toContain("onPointerDown");
    expect(MENU_POINTER_EVENTS).toContain("onTouchStart");
  });

  it("stops Enter and Space on an item, because the row has its own Enter", () => {
    for (const key of MENU_ACTIVATION_KEYS) {
      for (const name of ["onKeyDown", "onKeyUp"]) {
        const s = spy(key);
        (guards[name] as (e: unknown) => void)(s.e);
        expect(s.stopped, `${name} ${JSON.stringify(key)}`).toBe(1);
      }
    }
  });

  it("lets every other key through, so the app's chords still reach the window", () => {
    for (const key of ["Escape", "Tab", "k", "ArrowDown", "F10"]) {
      expect(swallowsKey(key), key).toBe(false);
      const s = spy(key);
      (guards.onKeyDown as (e: unknown) => void)(s.e);
      expect(s.stopped, key).toBe(0);
    }
  });
});

describe("ContextMenu wires it", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "components", "ContextMenu.tsx"), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*(\/\/|\/?\*|\{\/\*)/.test(l)).join("\n");
  const body = code.slice(code.indexOf("export function ContextMenu("), code.indexOf("export function MenuItem("));

  it("spreads the guards on one wrapper around the catcher and the menu", () => {
    expect(body).toContain("{...menuEventGuards()}");
    const wrapper = body.indexOf("{...menuEventGuards()}");
    expect(body.indexOf('className="fixed inset-0"')).toBeGreaterThan(wrapper);
    expect(body.indexOf('role="menu"')).toBeGreaterThan(wrapper);
  });

  it("closes on the click, not the press: the release must not belong to the row beneath", () => {
    const catcher = body.slice(body.indexOf('className="fixed inset-0"'), body.indexOf('<div ref={ref}'));
    expect(catcher).toContain("onClick={onClose}");
    expect(catcher).not.toContain("onMouseDown");
  });
});
