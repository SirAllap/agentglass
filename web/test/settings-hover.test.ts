import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/components/settingsGroupB.css", import.meta.url)).text();

/* Measured with a real pointer on every page: the working-day chips were the one control that did
   not answer a hover (no colour, edge or filter change). */
test("a day chip answers hover, chosen or not", () => {
  expect(css).toMatch(/\.agx-daychip:hover:not\(:disabled\):not\(\[aria-pressed="true"\]\)\s*\{[^}]*border-color/);
  expect(css).toMatch(/\.agx-daychip\[aria-pressed="true"\]:hover:not\(:disabled\)\s*\{[^}]*filter/);
});

const css2 = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const chrome = await Bun.file(new URL("../src/components/workspace/Chrome.tsx", import.meta.url)).text();
test("a filled primary button draws its focus ring outside, where blue on blue can be seen", () => {
  expect(css2).toMatch(/\.agx-btn\[data-tone="primary"\]:focus-visible\s*\{\s*outline-offset:\s*2px/);
  expect(chrome).toContain("data-tone={tint || on !== undefined ? undefined : tone}");
});

test("a name with no spaces wraps in a list row and in the editor's title instead of running out of the card", () => {
  expect(css2).toMatch(/\.agx-le-t \{[^}]*overflow-wrap: anywhere/);
  expect(css2).toMatch(/\.agx-le-et \{[^}]*overflow-wrap: anywhere/);
});
