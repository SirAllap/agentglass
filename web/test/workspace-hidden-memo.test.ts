/*
 * The seven views nobody can see stop re-rendering; the one on screen does not.
 *
 * Every visited view stays mounted — that is what makes switching instant — so
 * the app's ten-second tick re-rendered all of them. A plain `React.memo` would
 * have stopped that and also stopped the ACTIVE view, because on that tick its
 * props are equal too. What the tick exists for is state that moves without new
 * props: a status demoting to idle, "running Bash · 4m" advancing. Freezing the
 * view on screen would be a bug dressed as an optimisation, so the comparator
 * bails only when the view is hidden on both sides of the comparison.
 *
 * The switch itself is the case worth naming: hidden → active must render, or
 * you would arrive at the view you just left.
 */
import { describe, expect, test } from "bun:test";
import { hiddenOnly } from "../src/components/workspace/hiddenOnly.ts";

const noop = () => {};
const props = (over: Record<string, unknown> = {}) => ({ active: false, id: "git", openChat: noop, ...over });

describe("the hidden-only memo", () => {
  test("skips a re-render for a view nobody can see", () => {
    expect(hiddenOnly(props(), props())).toBe(true);
  });

  test("never skips one for the view on screen", () => {
    expect(hiddenOnly(props({ active: true }), props({ active: true }))).toBe(false);
  });

  test("never skips the switch, in either direction", () => {
    expect(hiddenOnly(props({ active: false }), props({ active: true }))).toBe(false);
    expect(hiddenOnly(props({ active: true }), props({ active: false }))).toBe(false);
  });

  test("a hidden view whose props actually changed still renders", () => {
    // A jump left in a slot for a view that is not on screen yet — arriving at
    // it has to find the request already applied.
    expect(hiddenOnly(props(), props({ prJump: { repo: "o/r", number: 1 } }))).toBe(false);
    expect(hiddenOnly(props({ chatFocusId: "a" }), props({ chatFocusId: "b" }))).toBe(false);
  });

  test("a prop disappearing counts as a change", () => {
    expect(hiddenOnly(props({ chatFocusId: "a" }), props())).toBe(false);
  });
});
