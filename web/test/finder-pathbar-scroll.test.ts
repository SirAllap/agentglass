/*
 * A long path is not squeezed: Strata's bar keeps every crumb whole, cuts one
 * label in its middle past 32 characters, rests at the end (the folder you are
 * in) and fades the side with more path. Squeezing left "~ / i / e / c...".
 */
import { describe, expect, test } from "bun:test";
import { CRUMB_MAX_CHARS, crumbFades, crumbLabel } from "../src/lib/finderMiller.ts";

const bar = await Bun.file(new URL("../src/components/finder/machine/FinderPathBar.tsx", import.meta.url)).text();

describe("crumbLabel", () => {
  test("a short name is whole", () => { expect(crumbLabel("orbit")).toBe("orbit"); expect(crumbLabel("x".repeat(32))).toBe("x".repeat(32)); });
  test("a long one keeps its start and its end around a single ellipsis, at the limit", () => {
    const l = crumbLabel("quarterly-planning-notes-for-the-orbit-team-final.md");
    expect([...l].length).toBe(CRUMB_MAX_CHARS);
    expect(l.startsWith("quarterly-planni")).toBe(true);
    expect(l.endsWith("-final.md")).toBe(true);
    expect(l).toContain("…");
  });
});

describe("crumbFades", () => {
  test("at the end only the left fades; at the start only the right; whole fits fade nothing", () => {
    expect(crumbFades(300, 200, 500)).toEqual({ left: true, right: false });
    expect(crumbFades(0, 200, 500)).toEqual({ left: false, right: true });
    expect(crumbFades(0, 500, 500)).toEqual({ left: false, right: false });
    expect(crumbFades(100, 200, 500)).toEqual({ left: true, right: true });
  });
});

describe("the bar", () => {
  test("the left hint takes room of its own and is never drawn over a crumb", () => {
    const at = bar.indexOf("data-crumb-more");
    expect(at).toBeGreaterThan(-1);
    const tag = bar.slice(bar.lastIndexOf("{fades.left", at), bar.indexOf("</span>", at));
    expect(tag).not.toContain("absolute");
    expect(bar).not.toMatch(/fades\.left && <span aria-hidden className="absolute/);
  });
  test("never shrinks a crumb, scrolls, and rests at the end", () => {
    expect(bar).toContain("overflow-x-auto");
    expect(bar).not.toMatch(/className="agx-btn rounded px-1 truncate"/);
    expect(bar).toContain("el.scrollLeft = el.scrollWidth");
    expect(bar).toContain("crumbLabel(c.label)");
  });
});
