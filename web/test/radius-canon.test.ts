/*
 * One radius scale, not a dialog rounder than its own menu.
 *
 * An audit counted `rounded-xl` (12px) as the house card/panel/popover/dialog
 * radius against 17 stray `rounded-2xl` dialogs and 17 more one-off
 * `rounded-[Npx]` values (10px nav tiles, 20px stat cards, 2-3px chart
 * cells). This asserts neither stray survives: every dialog, tile and swatch
 * now reads off the same short scale (`rounded-lg`/`rounded-xl`/`rounded-sm`
 * etc.), so nothing in `components/**` still spells its own radius in
 * brackets.
 *
 * Source is read as text and matched against source, per this repo's rule
 * for a decision that belongs on the screen rather than at runtime.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../src/components", import.meta.url).pathname;

function componentFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...componentFiles(p));
    else if (name.endsWith(".tsx")) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const files = componentFiles(ROOT);
const sources = new Map(await Promise.all(files.map(async (f) => [f, await Bun.file(f).text()] as const)));

describe("radius reads off the house scale", () => {
  it("never uses rounded-2xl", () => {
    for (const [, src] of sources) {
      expect(stripComments(src)).not.toContain("rounded-2xl");
    }
  });

  it("never spells a radius in brackets (rounded-[Npx])", () => {
    const arbitrary = /rounded-\[\d+px\]/;
    for (const [f, src] of sources) {
      expect(stripComments(src), f).not.toMatch(arbitrary);
    }
  });
});
