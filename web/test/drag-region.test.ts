/*
 * The bench window, dragged over the TopBar.
 *
 * Screenshotted: the TopBar sets `WebkitAppRegion: "drag"` on its own root so
 * the frameless window has something to be moved by (see TopBar.tsx). Electron
 * computes the OS drag rectangle from element geometry and ignores z-index, so
 * where the bench's freely-positioned window overlaps that strip, pressing on
 * the bench's own header dragged the whole app window instead of the bench.
 *
 * Source-level, because there is no renderer under `bun test` (see CLAUDE.md)
 * and the claim here is about which style object a component spreads onto its
 * root, not about pixels on screen.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const read = (...parts: string[]) => readFileSync(join(import.meta.dir, "..", "src", ...parts), "utf8");

describe("no-drag lives in one place", () => {
  test("TopBar no longer defines its own copy", () => {
    const src = read("components", "TopBar.tsx");
    expect(src).not.toContain('const NO_DRAG = { WebkitAppRegion: "no-drag" }');
    expect(src).toContain('from "../lib/dragRegion.ts"');
  });

  test("the shared constant is the one Electron pattern", () => {
    const src = read("lib", "dragRegion.ts");
    expect(src).toContain('WebkitAppRegion: "no-drag"');
  });
});

describe("the bench window opts out", () => {
  test("its root carries no-drag", () => {
    const src = read("components", "bench", "FloatingBench.tsx");
    // Isolate the motion.div that IS the bench window, not some other
    // fragment of the file, then check its own style object rather than
    // trusting a bare substring match anywhere in 1000+ lines.
    const start = src.indexOf("<motion.div\n              ref={winRef}");
    expect(start).not.toBe(-1);
    const styleStart = src.indexOf("style={{", start);
    const styleEnd = src.indexOf("}}", styleStart);
    const style = src.slice(styleStart, styleEnd);
    expect(style).toContain("...NO_DRAG");
    expect(src.slice(0, start)).toContain('import { NO_DRAG } from "../../lib/dragRegion.ts"');
  });
});
