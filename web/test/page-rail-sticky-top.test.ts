import { expect, test } from "bun:test";

// The "On this page" rail rode up 24-106 px on the first scroll: it was sticky at a fixed 24 px while
// its resting place sat lower (page header, scope control). Its sticky top must be the measured
// resting offset, and its scroll-spy must watch the element that scrolls, not the page.
const src = await Bun.file(new URL("../src/components/settings/shell/PageRail.tsx", import.meta.url)).text();
const code = src.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

test("non-chip rail sticks at the measured resting offset, not a fixed number", () => {
  expect(code.match(/position: "sticky", top: stickTop \?\? \d+, alignSelf: "flex-start"/)).not.toBeNull();
  expect(code.match(/position: "sticky", top: 24, alignSelf/)).toBeNull();
});

test("scroll-spy observes the scrolling ancestor", () => {
  expect(code.match(/const root = scrollParent\(nav\.current\)/)).not.toBeNull();
});
