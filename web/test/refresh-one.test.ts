/*
 * One refresh control, not twelve looks.
 *
 * An audit counted five different shapes for "read this again": text
 * "Refresh" six times, a bare icon three times, a bordered icon twice, icon
 * plus text once — and three of those twelve hand-rolled the round-arrow as
 * an inline `<path>` instead of `RefreshIcon`. `RefreshButton` in
 * `workspace/Chrome.tsx` replaced all twelve; this asserts none of the old
 * shapes came back.
 *
 * Source is read as text and matched against source, per this repo's rule
 * for a decision that belongs on the screen rather than at runtime: there is
 * no renderer here to mount the components and look.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src/components", import.meta.url).pathname;

/** Every `.tsx` file under `src/components`, recursively. */
function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...componentFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

const files = componentFiles(ROOT);
const sources = new Map(await Promise.all(files.map(async (f) => [f, await Bun.file(f).text()] as const)));

/** Strips line and block comments, because a quoted example inside one (this
 *  file's own header, or Chrome.tsx's) is not a live refresh button. */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("the header refresh control is drawn once", () => {
  it("never renders the word as a JSX text child", () => {
    // A `title="Refresh"` tooltip is fine and several controls keep one; what
    // is banned is the word sitting on screen as the button's own label.
    const label = />Refresh(?:ing)?\u2026?</;
    for (const [f, src] of sources) {
      expect(stripComments(src)).not.toMatch(label);
    }
  });

  it("never carries a hand-rolled refresh arrow", () => {
    // The path every inline SVG copy of `RefreshIcon` used, GitPanel's,
    // TasksPanel's card and TopBar's plan popover alike.
    for (const [f, src] of sources) {
      expect(src).not.toContain("M21 12a9 9 0 1 1-2.6-6.4");
    }
  });

  it("draws RefreshIcon straight inside a <button> only in Chrome.tsx", () => {
    // Every other bare-button RefreshIcon is a different verb wearing the same
    // glyph (Docker's restart, a pull request's re-run, Machine's "Measure
    // again", the ClickUp retry) and keeps its own wrapper (`DockerAction`,
    // `Btn`, a `<span>`) rather than a bare `<button>` with nothing else in it.
    const bareButtonRefresh = /<button[^>]*>\s*<RefreshIcon\b/;
    for (const [f, src] of sources) {
      if (f.endsWith("/workspace/Chrome.tsx")) continue;
      expect(stripComments(src)).not.toMatch(bareButtonRefresh);
    }
  });
});
