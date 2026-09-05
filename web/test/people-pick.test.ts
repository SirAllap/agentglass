/*
 * One people picker, and it stays on the screen.
 *
 * Two reports, one control. In the card view a 260px box anchored inside a cell
 * that sits well to the left ran off the LEFT of the pane and took its filter
 * box with it — "ilter people…", cut down the middle. Beside the pull request a
 * second, plainer list opened at the bottom right of the sidebar and ran off
 * the window: "that selection modal goes off screen and besides, it doesn't
 * follow the standard this one should".
 *
 * So the clamp is arithmetic (checkable here) and the picker is one component
 * (checked by reading both call sites).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { menuUnder, PICK_W, PICK_H } from "../src/lib/menuPos.ts";

const W = 1400, H = 900;
const at = (o: Partial<{ top: number; bottom: number; left: number }>) =>
  ({ top: 100, bottom: 120, left: 200, ...o });

describe("where the list lands", () => {
  test("under the control, when there is room", () => {
    expect(menuUnder(at({}), W, H)).toEqual({ top: 126, left: 200 });
  });

  test("above it when there is not, rather than over the control itself", () => {
    /* A menu pinned to the bottom edge under a control near the bottom covers
       the very thing it belongs to — which is what the sidebar's assignee
       control does, being the last thing in the column. */
    const p = menuUnder(at({ top: 700, bottom: 720 }), W, H);
    expect(p.top).toBe(700 - 6 - PICK_H);
  });

  test("and never off the right edge", () => {
    // The reported case: a control 40px from the right of the window.
    expect(menuUnder(at({ left: W - 40 }), W, H).left).toBe(W - PICK_W - 8);
  });

  test("nor off the left, on a window narrower than the menu", () => {
    expect(menuUnder(at({ left: 4 }), 200, H).left).toBe(8);
  });

  test("nor off the bottom, when neither side has room", () => {
    const p = menuUnder(at({ top: 300, bottom: 320 }), W, 360);
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.top + PICK_H).toBeLessThanOrEqual(360 + PICK_H); // clamped, not centred
  });
});

describe("one picker", () => {
  const read = (p: string) => readFileSync(new URL("../src/" + p, import.meta.url), "utf8");

  test("both places draw the same component", () => {
    expect(read("components/TasksPanel.tsx")).toContain("<PeoplePick");
    expect(read("components/PrPanel.tsx")).toContain("<PeoplePick");
  });

  test("and the one that grew it keeps its optimistic write", () => {
    /* The face appears or goes on the press, and `mine` with it. Lifting the
       markup out must not lift out the thing that makes it feel instant. */
    const tasks = read("components/TasksPanel.tsx");
    expect(tasks).toContain("optimistic: on");
    expect(tasks).toContain("go: (stamp) => api.clickupAssign(t.id, !on, stamp, m.id)");
  });

  test("it stays open across presses", () => {
    // Putting two people on and taking yourself off is one thought.
    const pick = read("components/PeoplePick.tsx");
    expect(pick).not.toContain("onPick(m); p.onClose()");
    expect(pick).toContain("onClick={() => p.onPick(m)}");
  });
});
