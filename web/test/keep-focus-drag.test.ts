/*
 * The focus guard must not cancel a drag.
 *
 * `keepTermFocus` works by calling `preventDefault` on the mousedown — that is
 * what stops the browser moving focus off the xterm textarea when you click the
 * panel's own chrome. It is also, exactly, how you tell the browser NOT to
 * begin a drag.
 *
 * So the tab strip carrying that handler could not have its tabs dragged at
 * all. The failure had no symptom to search for: the tab did not lift, which
 * reads as a feature nobody wired up rather than one being cancelled — the
 * handlers were plainly there in the shipped bundle. Found by reading this
 * file, after `setData` (the rail's own lesson) turned out not to be the cause.
 */
import { describe, expect, it } from "bun:test";
import { keepTermFocus } from "../src/lib/keepFocus.ts";

/** A mousedown on `target`, with the ancestors `closest` should find. */
function press(matches: string[]): { prevented: boolean } {
  let prevented = false;
  const target = {
    closest: (sel: string) => (matches.some((m) => sel.includes(m)) ? {} : null),
  };
  keepTermFocus({
    target,
    preventDefault: () => { prevented = true; },
  } as unknown as Parameters<typeof keepTermFocus>[0]);
  return { prevented };
}

describe("clicking the panel's own chrome", () => {
  it("keeps the terminal's cursor, which is the whole point", () => {
    // A button, a tab's padding, a menu's own background: nothing there wants
    // the focus, and without this the next keystroke lands nowhere.
    expect(press([]).prevented).toBe(true);
  });

  it("lets a text field take it, because that one is asking", () => {
    expect(press(["input"]).prevented).toBe(false);
  });

  it("lets a draggable element start its drag", () => {
    /* The regression this file exists for. `[draggable='true']` is the exact
       selector, so an element that merely *could* be dragged by some other
       mechanism is unaffected. */
    expect(press(["draggable"]).prevented).toBe(false);
  });
});
