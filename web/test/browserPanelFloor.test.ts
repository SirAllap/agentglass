import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Source-level: BrowserView lives in the workspace tree, so only a floor set
// inside it lifts its portals above the bench while the bench holds it.
const src = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url), "utf8");

test("BrowserView gives its portals the bench floor while the bench holds it", () => {
  expect(src).toContain("export function BrowserView(");
  expect(src).toMatch(/PortalFloor\.Provider value=\{place === "bench" && benchOpen \? LAYER\.benchOverlay : 0\}/);
  expect(src).toContain("browserPlace");
  // A closed bench zeroes its own floor (FloatingBench); the browser must not keep it lifted.
  expect(src).toContain("subscribeBench, benchState, benchState).open");
});

test("the ⋯ bar menu goes through Portal", () => {
  expect(src).toMatch(/const barMenu = [\s\S]{0,80}<Portal>/);
});
