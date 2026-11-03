import { test, expect } from "bun:test";

/*
 * Starboard's tiles and cards cut text with an ellipsis, which is only honest
 * when the full text is one hover away. These are claims about source, asserted
 * against source: there is no renderer here, and the measured side (scrollWidth
 * against clientWidth in the compiled app) is in the change description.
 */
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const panels = await Bun.file(new URL("../src/components/StarboardPanels.tsx", import.meta.url)).text();
const view = await Bun.file(new URL("../src/components/StarboardView.tsx", import.meta.url)).text();

const rule = (sel: string) => {
  const i = css.indexOf(`\n${sel} {`);
  expect(i).toBeGreaterThan(-1);
  return css.slice(i, css.indexOf("}", i));
};

test("every text the cards and tiles can cut has the full text as its house tip (data-tip), never the browser's own title", () => {
  expect(panels).toMatch(/className="sb-nm" data-tip=\{r\.name\}/);
  expect(panels).toMatch(/className="sb-doing" data-tip=\{/);
  expect(panels).toMatch(/className="sb-nt" data-tip=\{/);
  expect(view).toMatch(/className="sb-s" data-tip=\{sub\}/);
});

test("a card's status line wraps to two lines instead of hiding the rest", () => {
  const r = rule(".sb-doing");
  expect(r).toContain("-webkit-line-clamp: 2");
  expect(r).not.toContain("nowrap");
});

test("below the grid's minimum the screen reflows to two columns, never sideways", () => {
  const i = css.indexOf("@container sb (max-width: 1099px)");
  expect(i).toBeGreaterThan(-1);
  const block = css.slice(i, css.indexOf("\n}", i));
  expect(block).toContain("min-width: 0");
  expect(block).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
});

test("the quota panel scrolls inside its cell, and the throughput chart is never scrolled", () => {
  expect(css).toMatch(/\.sb-slot\[data-glyph="quota"\] > \.panel > \.panel-h \+ div\s*\{ overflow-y: auto; \}/);
  expect(css).toMatch(/\.sb-slot\[data-glyph="thru"\] > \.panel > \.panel-h \+ div\s*\{ min-height: 0; overflow: hidden; \}/);
  expect(css).not.toMatch(/data-glyph="thru"\][^{]*\{ overflow-y: auto/);
});

test("the name keeps a floor and the project pill gives way first", () => {
  expect(rule(".sb-nm")).toContain("min-width: 6em");
  expect(rule(".sb-pill")).toContain("flex: 0 1 auto");
});

test("a tip is never drawn twice, and it adds no cursor or hover ring of its own", () => {
  for (const src of [panels, view]) expect(src).not.toMatch(/ title=\{/);
  expect(css).not.toContain("--sb-lens");
  expect(css).not.toMatch(/\.sb[^{}]*\[data-tip\][^{}]*:hover/);
});
