import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const slip = src.slice(src.indexOf("const slipOf = "), src.indexOf("/* Alt held shows every hidden card"));

// A rule named after five card statuses ran past the lane's edge with no way to read it: the culprit truncates, the full text is the button's tooltip.
test("a hidden-card slip truncates a long rule name instead of overflowing", () => {
  expect(slip).toMatch(/min-w-0 max-w-\[70%\] truncate[^"]*">hidden by/);
  expect(slip).toContain("overflow-hidden");
  expect(slip).toContain("hidden by ${w?.name");
});
