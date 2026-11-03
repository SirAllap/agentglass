import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rule = css.slice(css.indexOf("\n.agx-cd {"), css.indexOf("\n.agx-cd::after"));

// Measured on porcelain: the card drew --surface-card (#f5f5f5) on a lane of --surface-card at 70% over white (#f8f8f8),
// so the card was the darker of the two. A card is one step lighter than its lane, on every palette.
test("the card is lifted above the lane, not the bare lane colour", () => {
  expect(rule).toMatch(/background: oklch\(from var\(--surface-card\) calc\(l \+ 0\.03\) c h\)/);
  expect(rule).not.toMatch(/background: var\(--surface-card\)/);
});
