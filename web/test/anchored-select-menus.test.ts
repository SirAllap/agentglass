/*
 * A select's list opens against ITS OWN control, wherever the page is scrolled.
 *
 * The step's "Also assign" list opened about 400px above the control that was
 * pressed, next to another step, over the statuses column. The popover it hung
 * from guessed a 430px height to decide whether to flip, so a three-row list
 * near the bottom of the window was placed 430px above the button's bottom edge,
 * and it was placed once, so a scroll of the Settings page left it behind.
 *
 * What is pinned: the placement is a function of the control's rectangle AS IT
 * IS NOW and the list's REAL height; a scrolled container only moves the
 * rectangle, so following a scroll is recomputing with the new one; and the
 * lists that used to guess are the ones that measure.
 */
import { describe, expect, test } from "bun:test";
import { MENU_GAP, MENU_MARGIN, placeMenu } from "../src/lib/menuPlacement.ts";

const VIEW = { width: 1400, height: 800 };
/** A control `y` px from the top of a scroller that has scrolled by `scrollTop`. */
const control = (y: number, scrollTop: number, h = 32) => ({ left: 640, right: 840, top: y - scrollTop, bottom: y - scrollTop + h });

describe("placement against the trigger as it is now", () => {
  test("a short list for a control near the bottom opens just above it, not a guessed 430px higher", () => {
    const list = { width: 200, height: 96 };
    const a = control(2000, 1240); // 760..792 in the window
    const p = placeMenu(a, list, VIEW, "left");
    expect(p.side).toBe("above");
    expect(p.top + list.height).toBe(a.top - MENU_GAP); // its bottom edge sits one gap above the control
    expect(a.top - (p.top + list.height)).toBeLessThan(20);
    expect(p.left).toBe(a.left);
  });
  test("the same control after the container scrolls: placed again against the new rectangle, and it goes below when there is room", () => {
    const list = { width: 200, height: 96 };
    const before = placeMenu(control(2000, 1240), list, VIEW, "left");
    const after = placeMenu(control(2000, 1700), list, VIEW, "left"); // control now at 300
    expect(after.side).toBe("below");
    expect(after.top).toBe(300 + 32 + MENU_GAP);
    expect(after.top).not.toBe(before.top);
  });
  test("a tall list near the bottom is capped to the room, not pushed off the window", () => {
    const p = placeMenu(control(2000, 1240), { width: 380, height: 700 }, VIEW, "left");
    expect(p.maxHeight).toBeLessThanOrEqual(VIEW.height - 2 * MENU_MARGIN);
    expect(p.top).toBeGreaterThanOrEqual(0);
  });
  test("a control at the right edge shifts the list back inside the window", () => {
    const p = placeMenu({ left: 1300, right: 1390, top: 100, bottom: 132 }, { width: 380, height: 96 }, VIEW, "left");
    expect(p.left + 380).toBeLessThanOrEqual(VIEW.width - MENU_MARGIN);
  });
});

describe("the lists that open from the steps measure, and follow", () => {
  const read = (f: string) => Bun.file(new URL(`../src/${f}`, import.meta.url).pathname).text();
  test("add a block, who comes off and assign are AnchoredMenus, not popovers with a guessed height", async () => {
    const src = await read("components/StepBlocks.tsx");
    expect(src).toContain("<AnchoredMenu anchor={anchorRef}");
    expect(src.match(/<AnchoredMenu /g)?.length).toBe(3);
    expect(src).not.toContain("StatusPopover");
  });
  test("the status popover is placed with its real height and again on scroll and resize, inside any scroller", async () => {
    const src = await read("components/StatusPanel.tsx");
    const at = src.indexOf("export function StatusPopover");
    const body = src.slice(at, src.indexOf("\nexport ", at + 10) < 0 ? undefined : src.indexOf("\nexport ", at + 10));
    expect(body).toContain("el.offsetHeight");
    expect(body).toContain('document.addEventListener("scroll", place, true)');
    expect(body).toContain('window.addEventListener("resize", place)');
    expect(body).not.toContain("430");
  });
});
