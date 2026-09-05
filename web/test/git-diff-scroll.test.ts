/*
 * The column that scrolls the diff in the Git view.
 *
 * This is a layout lock, and it is written down because the shape of it is not
 * obvious and it has now been got wrong twice.
 *
 * The diff panes pin `overflow-y: hidden` on purpose — `overflow-x: auto`
 * computes `overflow-y: auto` unless the other axis is set, and two nested
 * vertical scrollers is the double-scroll this app already fixed once. The
 * panes therefore expect an OUTER column to do the scrolling, and they say so:
 * "they grow to the same height inside whatever scrolls the page".
 *
 * The trap is that the outer column must not be a FLEX ROW. A flex row
 * stretches its children to its own height, and a child with `overflow-y:
 * hidden` then clips its content instead of growing past it — so the container
 * gets a scrollbar that scrolls nothing, because as far as it is concerned
 * there is nothing below. Measured in Chrome, same nesting, 200 lines:
 *
 *     flex container   scrollHeight 280 = clientHeight 280   scrollable: false
 *     block container  scrollHeight 2815 > clientHeight 280  scrollable: true
 *
 * There is no layout engine under `bun test`, so this asserts the decision
 * rather than the pixels.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const panel = readFileSync(new URL("../src/components/GitPanel.tsx", import.meta.url).pathname, "utf8");
const diffLines = readFileSync(new URL("../src/components/diff/DiffLines.tsx", import.meta.url).pathname, "utf8");

/** The one element the diff is rendered into. */
const container = /<div className="([^"]*)" data-diff-scroller/.exec(panel)?.[1] ?? "";

describe("the Git view's diff column", () => {
  test("it exists and is marked, so this test cannot silently stop testing", () => {
    expect(container).toBeTruthy();
  });

  test("it scrolls vertically — nothing else in that column does", () => {
    expect(container).toContain("overflow-y-auto");
  });

  /* The half that took two goes. */
  test("and it is NOT a flex row, or the panes clip instead of growing", () => {
    expect(container.split(/\s+/)).not.toContain("flex");
  });
});

describe("the panes it scrolls", () => {
  test("still pin their own vertical axis, which is why the column has to", () => {
    // If these ever go back to `overflow: auto`, the column above becomes the
    // second scroller and the wheel starts fighting itself again.
    const panes = [...diffLines.matchAll(/overflowX: "auto", overflowY: "hidden"/g)];
    expect(panes.length).toBeGreaterThanOrEqual(2);
  });
});
