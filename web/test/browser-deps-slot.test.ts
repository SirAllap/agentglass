import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/* The omnibox rows memo is per component instance: a module-level slot hands one instance the rows another built from its own closures. */
const src = readFileSync(join(import.meta.dir, "../src/components/BrowserPanel.tsx"), "utf8");

test("lastDeps keeps no module-level state", () => {
  expect(src).not.toMatch(/^let depsSlot/m);
});

test("the memo slot is a useRef declared above the early return", () => {
  const body = src.slice(src.indexOf("function BrowserViewBody"));
  const slot = body.indexOf("useRef<DepsSlot");
  const early = body.indexOf("if (!HAS_BROWSER && !IS_DEMO && !forced) return null;");
  expect(slot).toBeGreaterThan(-1);
  expect(slot).toBeLessThan(early);
});
