/*
 * The message and the meters, when they want the same pixels.
 *
 * Reported with a screenshot of a notification running under the plan meters:
 * "look how they overlap when the notification shows up… maybe we should hide
 * the usage for a moment so the notification can be read… is that possible?
 * knowing exactly when there is a collision?".
 *
 * It is, and this is the arithmetic that knows: the centred slot's right edge
 * against the left edge of the group on the right. The numbers come from
 * `getBoundingClientRect` in the component — the browser's own answer — so what
 * is worth pinning here is the part that is ours: the gap, the hysteresis, and
 * the rule that the meters are the normal state rather than a fallback.
 */
import { describe, expect, test } from "bun:test";
import { metersMustHide, TOPBAR_GAP, TOPBAR_SLACK } from "../src/lib/topbarFit.ts";

const fit = (o: Partial<Parameters<typeof metersMustHide>[0]>) =>
  metersMustHide({ slotRight: 0, rightEdge: 1000, occupied: true, hidden: false, ...o });

describe("who gives way", () => {
  test("a message that clears the meters leaves them alone", () => {
    expect(fit({ slotRight: 800, rightEdge: 1000 })).toBe(false);
  });

  test("one that would run under them sends them away", () => {
    expect(fit({ slotRight: 1010, rightEdge: 1000 })).toBe(true);
  });

  test("and so does one that merely touches them", () => {
    // Not overlapping yet, but with nothing between the two they read as one
    // run of text — which is the complaint, not "the pixels intersect".
    expect(fit({ slotRight: 1000 - TOPBAR_GAP + 1, rightEdge: 1000 })).toBe(true);
    expect(fit({ slotRight: 1000 - TOPBAR_GAP, rightEdge: 1000 })).toBe(false);
  });

  test("an empty middle never costs the meters anything", () => {
    /* The bar's normal state is meters and clock. `occupied` is false whenever
       the slot holds nothing, and then no arithmetic applies — a slot of zero
       width sitting at the centre would otherwise still be "close enough" to
       the right group on a very narrow window. */
    expect(fit({ slotRight: 2000, rightEdge: 100, occupied: false })).toBe(false);
  });
});

describe("and how they come back", () => {
  test("hidden, it takes more than the bare minimum of room", () => {
    /* The flap this prevents: the meters go, their width is freed, the freed
       width says there is room, they return, they collide. Several times a
       second on a bar somebody is reading. */
    const justFits = 1000 - TOPBAR_GAP - 1;
    expect(fit({ slotRight: justFits, rightEdge: 1000, hidden: false })).toBe(false);
    expect(fit({ slotRight: justFits, rightEdge: 1000, hidden: true })).toBe(true);
    expect(fit({ slotRight: justFits - TOPBAR_SLACK, rightEdge: 1000, hidden: true })).toBe(false);
  });

  test("the same numbers decide it whether they are showing or not", () => {
    /* `rightEdge` is the edge AS IF the meters were showing — the component
       adds their remembered width back while they are gone. Without that the
       input to this decision would move every time the decision did, which is
       the loop the slack alone cannot fix. */
    const showing = metersMustHide({ slotRight: 900, rightEdge: 880, occupied: true, hidden: false });
    const hiddenNow = metersMustHide({ slotRight: 900, rightEdge: 880, occupied: true, hidden: true });
    expect(showing).toBe(true);
    expect(hiddenNow).toBe(true);
  });
});

/*
 * And the part the arithmetic cannot see: WHEN it is asked.
 *
 * A ResizeObserver reports SIZE, not position. Measured in Chrome on a replica
 * of this strip: narrowing the window from 1280 to 860 changed the size of
 * neither the slot (capped at `min(46vw, 460px)`, and 46vw is still over 460
 * all the way down) nor the right group — so observing only those two, the
 * callback never fired and the message sat under the meters at 1100, 980 and
 * 860 with the decision above saying "hide" and nobody asking it. The bar is
 * the box whose size does change with the window.
 *
 * Source-level, because there is no layout engine under `bun test` and this is
 * a claim about which boxes are observed, not about what they measure.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("what gets watched", () => {
  const src = readFileSync(join(import.meta.dir, "..", "src", "components", "TopBar.tsx"), "utf8");

  test("all three boxes, and the bar is one of them", () => {
    for (const box of ["ro.observe(slot);", "ro.observe(right);", "ro.observe(bar);"]) {
      expect(src).toContain(box);
    }
  });

  test("the meters are one box, marked, and it is the only thing that hides", () => {
    /* The clock, the bell and the window buttons are furniture people navigate
       by — they stay. Only the reading and its rule stand down. */
    expect(src).toContain('data-topbar-meters');
    expect(src).toContain('display: metersHidden ? "none" : undefined');
    expect((src.match(/metersHidden \? "none"/g) ?? []).length).toBe(1);
  });

  test("the geometry is fed back as if the meters were showing", () => {
    // Without this the input moves whenever the decision does, and the strip
    // flaps several times a second. See metersWide in the component.
    expect(src).toContain("rightEdge: r.left - (hidden ? metersWide.current : 0)");
  });
});
