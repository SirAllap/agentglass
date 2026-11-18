/*
 * No native tooltip left in the Browser view, and its layers by name.
 *
 * The house tooltip is TipHost: an element carries `data-tip` and one host
 * draws the card. A `title=` on a plain DOM tag shows the browser's own grey
 * box instead, late and unstyled, beside the house one on the next control.
 * The Browser view (BrowserPanel and components/browser/) was moved to
 * `data-tip`; this file fails the day one of its files gets a native `title`
 * back, or a bare z-index number instead of a BROWSER rung.
 *
 * Source-level, like house-style.test.ts. Only lowercase tags count: a
 * `title` prop on a component (Button) is that component's own contract, not
 * the browser's attribute.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BROWSER } from "../src/lib/layers.ts";

const COMPONENTS = resolve(import.meta.dir, "../src/components");
const FILES = [
  "BrowserPanel.tsx",
  ...readdirSync(join(COMPONENTS, "browser")).filter((n) => n.endsWith(".tsx") && !n.includes(".test.")).map((n) => `browser/${n}`),
];

/** `file:line <tag title=` for every native title on a lowercase tag. */
function nativeTitles(rel: string): string[] {
  const text = readFileSync(join(COMPONENTS, rel), "utf8");
  const out: string[] = [];
  for (const m of text.matchAll(/\btitle=[{"']/g)) {
    const at = m.index ?? 0;
    const open = text.lastIndexOf("<", at);
    const tag = /^<([A-Za-z][\w.]*)/.exec(text.slice(open, open + 40));
    if (tag && /^[a-z]/.test(tag[1])) out.push(`${rel}:${text.slice(0, at).split("\n").length} <${tag[1]} title=`);
  }
  return out;
}

describe("Browser view: house tooltip and named layers", () => {
  test("no native title= on a DOM tag", () => {
    expect(FILES.length).toBeGreaterThan(5);
    expect(FILES.flatMap(nativeTitles)).toEqual([]);
  });

  test("no bare zIndex number", () => {
    const bare = FILES.flatMap((rel) => {
      const text = readFileSync(join(COMPONENTS, rel), "utf8");
      return [...text.matchAll(/zIndex:\s*\d+|z-\[\d+\]/g)].map((m) => `${rel}: ${m[0]}`);
    });
    expect(bare).toEqual([]);
  });

  // Naming the numbers must not have reordered them: each pair a scrim and
  // what it holds, and the drag ghost over everything in the panel.
  test("the stacking order is the one the numbers had", () => {
    expect(BROWSER.tabBehind).toBeLessThan(BROWSER.tabFront);
    expect(BROWSER.splitGrip).toBeLessThan(BROWSER.splitTools);
    expect(BROWSER.overlay).toBeLessThan(BROWSER.shooter);
    expect(BROWSER.omniScrim).toBeLessThan(BROWSER.omni);
    expect(BROWSER.menuScrim).toBeLessThan(BROWSER.menu);
    expect(BROWSER.bringScrim).toBeLessThan(BROWSER.bring);
    expect(Math.max(...Object.values(BROWSER))).toBe(BROWSER.carry);
  });
});
