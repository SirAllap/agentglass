import { test, expect } from "bun:test";

const src = await Bun.file(new URL("../src/components/InsightsModal.tsx", import.meta.url)).text();

// A fixed 1080 px left the changelog and the charts cramped on a wide screen.
test("Insights opens as a share of the window, not a fixed width", () => {
  expect(src).toMatch(/<GitDialog title="Insights"[^>]*width="min\(\d+px, \d+vw\)"/);
  expect(src).not.toContain("width={1080}");
});
