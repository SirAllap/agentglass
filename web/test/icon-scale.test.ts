/*
 * The icon ladder, held in place.
 *
 * An audit of the cockpit found 61 vector icon sites across fourteen sizes —
 * 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 26, 46 — and 45 close controls
 * drawn as a `✕` character at eight more, twenty-five of which had no size at
 * all and inherited whatever the container set. Nothing was wrong in any one
 * place; there was simply no rule, so every new icon was sized against its
 * neighbour and the set drifted.
 *
 * Two rules, and this is where they are kept:
 *
 *   1. Nothing renders below ICON.xs. Under 12px a stroked glyph stops
 *      resolving into a shape on a 1x display, which is what "the icons are
 *      tiny" turned out to mean — the report came from a 93 DPI panel.
 *   2. A close button is <CloseButton/>, not a `✕`. The character draws far
 *      less ink than its font-size implies (about 7px at 11px type) and gave
 *      the control no height of its own, leaving a target around 15px tall.
 *
 * Source text rather than a rendered tree: these are authoring rules about how
 * the next icon gets written, and this repo has no DOM test harness to render
 * 200 components into. The cost is that it cannot see a size arriving through
 * a variable — which is fine, because the ladder is the variable.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { ICON, HIT } from "../src/lib/iconSize.ts";

const SRC = resolve(import.meta.dir, "..", "src");

function tsxFiles(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) tsxFiles(p, out);
    else if (e.endsWith(".tsx")) out.push(p);
  }
  return out;
}
const FILES = tsxFiles(SRC).map((f) => ({ rel: relative(SRC, f), text: readFileSync(f, "utf8") }));

describe("the ladder itself", () => {
  test("ascends, never repeats a size, and has a 12px floor", () => {
    const rungs = Object.values(ICON);
    expect(rungs).toEqual([...rungs].sort((a, b) => a - b));
    expect(new Set(rungs).size).toBe(rungs.length);
    expect(Math.min(...rungs)).toBe(12);
  });

  test("the hit target is bigger than the glyph it holds", () => {
    // Otherwise the box is decoration: the thing you aim at would still be the
    // glyph, which is the state this replaced.
    expect(HIT).toBeGreaterThan(ICON.md);
  });
});

/**
 * The one way out of the floor, and it costs a written reason.
 *
 * The floor is about things you *aim at*: under 12px a stroked glyph stops
 * resolving on a 1x panel, and a control you cannot resolve is one you cannot
 * hit. A status mark you only have to notice is a different problem — the phone
 * badge on a tmux window tab sits beside a one-digit window number, and drawn
 * at 12px it is bigger than the number it annotates.
 *
 * So: an opt-out that a person has to type on the line, with the reason next to
 * it. `// eslint-disable`-shaped on purpose — the point is that it appears in
 * the diff and has to be justified there, not that it is convenient.
 */
const EXEMPT = /icon-floor-exempt:/;

describe("no icon renders below the floor", () => {
  test("no inline <svg> is smaller than ICON.xs", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      const lines = text.split("\n");
      lines.forEach((ln, i) => {
        const m = /<svg[^>]*\bwidth=(?:\{(\d+(?:\.\d+)?)\}|"(\d+(?:\.\d+)?)")/.exec(ln);
        const px = m ? Number(m[1] ?? m[2]) : null;
        if (px === null || px >= ICON.xs) return;
        // The marker is allowed on the tag's own line or the one above it, which
        // is where a JSX comment ends up when the tag is already long.
        if (EXEMPT.test(ln) || EXEMPT.test(lines[i - 1] ?? "")) return;
        bad.push(`${rel}:${i + 1} → ${px}px`);
      });
    }
    expect(bad, "use a rung from ICON (lib/iconSize.ts), or mark it `icon-floor-exempt: <why>`").toEqual([]);
  });

  test("no icon component defaults below ICON.xs", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      text.split("\n").forEach((ln, i) => {
        if (/font-size\s*:/.test(ln)) return;
        const m = /\bsize\s*=\s*(\d+(?:\.\d+)?)\b/.exec(ln);
        if (m && /function |\{ size/.test(ln) && Number(m[1]) < ICON.xs) {
          bad.push(`${rel}:${i + 1} → ${m[1]}px`);
        }
      });
    }
    expect(bad).toEqual([]);
  });
});

describe("close controls", () => {
  /**
   * A `✕` alone inside a button. A labelled one — "Clear ✕", "✕ Deny" — is a
   * different control and keeps its glyph, and so does every ✕ used as a status
   * mark (a failed check, a rejected review), which is text and not a button.
   */
  test("no button is just a ✕ character", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      if (rel === "components/CloseButton.tsx") continue;
      for (const m of text.matchAll(/<button\b[\s\S]*?>\s*✕\s*<\/button>/g)) {
        bad.push(`${rel} → ${text.slice(0, m.index).split("\n").length}`);
      }
    }
    expect(bad, "use <CloseButton/> from components/CloseButton.tsx").toEqual([]);
  });
});

describe("a glyph is not a control", () => {
  /**
   * The gap this closes, found the hard way.
   *
   * Every rule above is about `<svg width={ICON.x}>`, so a control drawn with a
   * CHARACTER walked straight past all of them. The branch list's tick box was
   * `☐` at 11px inside a `<span onClick>`: seven pixels of outline, no tick you
   * could see when it was on, no role, no keyboard, and a target the size of
   * the glyph. Reported as "el checkbox es ENANO, ni se ve", on the one list
   * where knowing what you have selected is the entire feature.
   *
   * So: a box, a tick, a caret or a spinner that IS the control gets drawn.
   * A glyph sitting next to a word ("⌫ 3 gone", "▣ stash some files…") is
   * decoration on a labelled button and stays — the label is the control.
   */
  const GLYPHS = "☐☑☒▶▼▸▾▴◀⟳↻⌕";

  test("no clickable element is a bare glyph", () => {
    const bad: string[] = [];
    for (const { rel, text } of FILES) {
      for (let i = 0; i < text.length; i++) {
        if (!GLYPHS.includes(text[i]!)) continue;
        /* Walk BACK to the element this glyph sits in rather than matching the
           tag with a regex: an attribute holding an arrow function contains a
           `>`, so `<span([^>]*)>` stops at `=>` and every handler in the app
           slips through. That is exactly how the first version of this guard
           passed over the very control it was written for. */
        const before = text.slice(Math.max(0, i - 400), i);
        const open = Math.max(before.lastIndexOf("<span"), before.lastIndexOf("<button"), before.lastIndexOf("<div"), before.lastIndexOf("<a "));
        if (open === -1) continue;
        const head = before.slice(open);
        if (!/\bonClick=/.test(head) && !head.startsWith("<button")) continue;
        // A glyph beside a word is decoration on a labelled control: "⌫ 3 gone",
        // "▣ stash some files…". The label is the control, and it stays.
        const after = text.slice(i + 1, i + 60);
        if (/[A-Za-z0-9]/.test(after.split("<")[0] ?? "")) continue;
        if (/[A-Za-z0-9]/.test(head.slice(head.lastIndexOf(">") + 1))) continue;
        bad.push(`${rel}:${text.slice(0, i).split("\n").length} ${text[i]}`);
      }
    }
    expect(bad, "draw it: an <svg> at ICON.xs or more, in a target of HIT").toEqual([]);
  });
});
