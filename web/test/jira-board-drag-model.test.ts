/*
 * The pure pieces of the board's pointer drag (jira/list/dragModel.ts): the threshold that tells a drag from a
 * click, which slot a pointer is over, which edge to auto-scroll toward, and the confirm-then-commit timer. None of
 * it needs a renderer, and JiraBoard.tsx only asks these questions.
 */
import { describe, expect, test } from "bun:test";
import {
  CONFIRM_TIMEOUT_MS, DRAG_THRESHOLD_PX, edgeScroll, pastThreshold, pendingExpired, slotIndex, startPending,
} from "../src/components/jira/list/dragModel.ts";

describe("pastThreshold", () => {
  test("short of it on both axes is still a click", () => {
    expect(pastThreshold(DRAG_THRESHOLD_PX - 1, 0)).toBe(false);
    expect(pastThreshold(0, DRAG_THRESHOLD_PX - 1)).toBe(false);
    expect(pastThreshold(DRAG_THRESHOLD_PX - 1, DRAG_THRESHOLD_PX - 1)).toBe(false);
  });
  test("at or past it, on either axis, is a drag", () => {
    expect(pastThreshold(DRAG_THRESHOLD_PX, 0)).toBe(true);
    expect(pastThreshold(0, -DRAG_THRESHOLD_PX)).toBe(true);
  });
});

describe("slotIndex", () => {
  const rects = [{ id: "a", top: 0, height: 100 }, { id: "b", top: 100, height: 100 }, { id: "c", top: 200, height: 100 }];
  test("above the first card's midpoint: the top slot", () => { expect(slotIndex(10, rects)).toBe(0); });
  test("past the first card's midpoint, short of the second's: between them", () => { expect(slotIndex(60, rects)).toBe(1); });
  test("past the second card's midpoint too: after both, before the third", () => { expect(slotIndex(160, rects)).toBe(2); });
  test("below every card: the last slot", () => { expect(slotIndex(500, rects)).toBe(3); });
  test("an empty column: the only slot there is", () => { expect(slotIndex(50, [])).toBe(0); });
});

describe("edgeScroll", () => {
  const bounds = { left: 0, right: 1000 };
  test("away from both edges: no scroll", () => { expect(edgeScroll(500, bounds)).toEqual({ dir: 0, px: 0 }); });
  test("at the left edge itself: scrolls left, fastest", () => {
    const at0 = edgeScroll(0, bounds);
    expect(at0.dir).toBe(-1);
    expect(at0.px).toBeGreaterThan(edgeScroll(40, bounds).px);
  });
  test("at the right edge itself: scrolls right", () => { expect(edgeScroll(999, bounds).dir).toBe(1); });
  test("just past the zone: no scroll yet", () => { expect(edgeScroll(49, bounds)).toEqual({ dir: 0, px: 0 }); });
});

describe("a drop waiting for a yes", () => {
  test("not expired until its window is up, then it is, for good", () => {
    const p = startPending("c1", "To do", "Done", 1000);
    expect(p.expiresAt).toBe(1000 + CONFIRM_TIMEOUT_MS);
    expect(pendingExpired(p, 1000)).toBe(false);
    expect(pendingExpired(p, p.expiresAt - 1)).toBe(false);
    expect(pendingExpired(p, p.expiresAt)).toBe(true);
    expect(pendingExpired(p, p.expiresAt + 500)).toBe(true);
  });
});
