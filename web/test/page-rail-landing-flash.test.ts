import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { foldedToOpen, jumpMoves, prefersReducedMotion, RAIL_FLASH_MS } from "../src/components/settings/shell/PageRail.tsx";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

/** A tiny element tree: enough of Element for foldedToOpen (tagName, parentElement, querySelector, closest). */
type Fake = { tagName: string; open?: boolean; parentElement: Fake | null; kids: Fake[]; section?: boolean;
  querySelector(sel: string): Fake | null; closest(sel: string): Fake | null };
function node(tagName: string, parent: Fake | null, extra: Partial<Fake> = {}): Fake {
  const n: Fake = {
    tagName, parentElement: parent, kids: [], ...extra,
    querySelector(sel) { const walk = (f: Fake): Fake | null => { for (const k of f.kids) { if (sel === "details" && k.tagName === "DETAILS") return k; const r = walk(k); if (r) return r; } return null; }; return walk(n); },
    closest(sel) { for (let f: Fake | null = n; f; f = f.parentElement) if (sel === "[data-section]" && f.section) return f; return null; },
  };
  parent?.kids.push(n);
  return n;
}

describe("rail jump: the flash starts when the jump ends", () => {
  test("a jump that moves the scroller waits for scrollend", () => {
    expect(jumpMoves(0, 800, 4000)).toBe(true);
    expect(jumpMoves(1200, -900, 4000)).toBe(true);
  });
  test("no scroll needed (already there, or the end of the page cannot come higher) flashes at once", () => {
    expect(jumpMoves(500, 0, 4000)).toBe(false);
    expect(jumpMoves(500, 0.6, 4000)).toBe(false);
    expect(jumpMoves(4000, 300, 4000)).toBe(false); // last section in view at the bottom
    expect(jumpMoves(0, -40, 4000)).toBe(false); // first section at the top
  });
  test("the jump listens for scrollend once, and flashes directly otherwise", () => {
    const rail = src("components/settings/shell/PageRail.tsx");
    expect(rail).toContain('box.addEventListener("scrollend", fn, { once: true });');
    expect(rail).not.toContain("setTimeout");
  });
});

describe("rail jump: a folded target opens first", () => {
  test("the section's own closed <details> opens; an open one is left alone", () => {
    const sec = node("SECTION", null, { section: true });
    const d = node("DETAILS", sec, { open: false });
    expect(foldedToOpen(sec as unknown as Element)).toEqual([d as unknown as HTMLDetailsElement]);
    d.open = true;
    expect(foldedToOpen(sec as unknown as Element)).toEqual([]);
  });
  test("a closed <details> around the section opens, outermost first", () => {
    const outer = node("DETAILS", null, { open: false });
    const inner = node("DETAILS", outer, { open: false });
    const sec = node("SECTION", inner, { section: true });
    expect(foldedToOpen(sec as unknown as Element)).toEqual([outer, inner] as unknown as HTMLDetailsElement[]);
  });
  test("a <details> inside a nested section is not this section's fold", () => {
    const sec = node("SECTION", null, { section: true });
    const child = node("SECTION", sec, { section: true });
    node("DETAILS", child, { open: false });
    expect(foldedToOpen(sec as unknown as Element)).toEqual([]);
  });
  test("the folds open before the scroll is measured", () => {
    const rail = src("components/settings/shell/PageRail.tsx");
    expect(rail.indexOf("d.open = true")).toBeLessThan(rail.indexOf("getBoundingClientRect().top - box.getBoundingClientRect().top - margin"));
  });
});

describe("rail jump: reduced motion", () => {
  const doc = (attr: boolean) => ({ documentElement: { hasAttribute: (a: string) => attr && a === "data-reduce-motion" } }) as unknown as Document;
  test("the system preference or the app setting each count", () => {
    expect(prefersReducedMotion(doc(false), () => ({ matches: false }))).toBe(false);
    expect(prefersReducedMotion(doc(false), () => ({ matches: true }))).toBe(true);
    expect(prefersReducedMotion(doc(true), () => ({ matches: false }))).toBe(true);
  });
  test("the mark lasts 1.2 s, fades normally, is a static step under reduced motion, and never moves layout", () => {
    expect(RAIL_FLASH_MS).toBe(1200);
    const css = src("index.css");
    const block = css.slice(css.indexOf("[data-section][data-rail-flash]"), css.indexOf("html[data-reduce-motion] [data-section][data-rail-flash]") + 140);
    expect(block).toContain("animation: agx-rail-flash 1.2s ease-out forwards");
    expect(block).toContain("animation-timing-function: step-end");
    expect(block).toContain("animation: agx-rail-flash 1.2s step-end forwards !important");
    expect(block).not.toMatch(/\b(border|padding|margin)\s*:/);
  });
});
