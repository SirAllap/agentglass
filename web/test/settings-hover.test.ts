import { expect, test } from "bun:test";

const css = await Bun.file(new URL("../src/components/settingsGroupB.css", import.meta.url)).text();

/* Measured with a real pointer on every page: the working-day chips were the one control that did
   not answer a hover (no colour, edge or filter change). */
test("a day chip answers hover, chosen or not", () => {
  expect(css).toMatch(/\.agx-daychip:hover:not\(:disabled\):not\(\[aria-pressed="true"\]\)\s*\{[^}]*border-color/);
  expect(css).toMatch(/\.agx-daychip\[aria-pressed="true"\]:hover:not\(:disabled\)\s*\{[^}]*filter/);
});
