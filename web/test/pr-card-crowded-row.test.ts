import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const card = await Bun.file(new URL("../src/components/PrCard.tsx", import.meta.url)).text();

// A long status ("ready for deployment") sat on top of the copy buttons: when the row is crowded the buttons replace the status under the pointer.
test("a crowded ticket row hides the copy buttons until the pointer is on it, and hides the status then", () => {
  expect(css).toMatch(/\.agx-cd-m\[data-crowded\] > \.agx-cd-ccs \{[^}]*opacity: 0/);
  expect(css).toMatch(/\.agx-cd-m\[data-crowded\]:hover > \.agx-cd-ccs[^{]*\{[^}]*opacity: 1/);
  expect(css).toMatch(/\.agx-cd-m\[data-crowded\]:hover \.agx-cd-tag[^{]*\{[^}]*opacity: 0/);
});

test("the card marks the row crowded from measured widths, not from the status text", () => {
  expect(card).toContain('data-crowded={crowded ? "1" : undefined}');
  expect(card).toContain("left.offsetWidth + ccs.offsetWidth");
});

// A chain hangs on a 26px rail: the card that is not in the chain sat flush left, off the column's edge.
test("a lane with a rail gives the cards without one the same left edge", () => {
  expect(css).toMatch(/\.agx-cd-gut \{ margin-left: 26px; \}/);
  expect(card).toContain('props.gutter ? <div className="agx-cd-gut">');
});

// The last card of a chain has no link going down, and its wrapper zeroed the card's own bottom margin: the next card sat glued to it.
test("a card on the rail keeps the gap below it even when it is the last of its chain", () => {
  expect(css).toMatch(/\.agx-cd-rail \{[^}]*margin-bottom: 8px/);
});
