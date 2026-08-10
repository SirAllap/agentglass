/*
 * The spacing scale, enforced.
 *
 * The app already had a rhythm and no record of it. Measured across web/src
 * when this was written: 3,714 spacing utilities, of which 97.8% already land
 * on a 2px grid. The disorder was never the common case — it was that nothing
 * declared the grid and nothing stopped the exceptions poking through it:
 * arbitrary values on odd pixels (`py-[3px]`, `gap-[9px]`) and inline
 * `paddingLeft: 3`, neither of which any scale produces.
 *
 * So this does not invent a scale. It holds the app to its own, the same way
 * deps-catalog.test.ts holds the requirements page to what the code actually
 * runs — and for the same reason: a convention nothing checks is a convention
 * that has already drifted, quietly, in the direction of whoever was last in a
 * hurry.
 *
 * Two rules, and the second is the one that matters:
 *
 *   1. Spacing goes through Tailwind's scale, which is a 2px grid.
 *   2. An arbitrary value (`gap-[9px]`) or an inline `padding:` has to be
 *      exempt BY NAME, with a reason. That is what turns "off the scale" from
 *      something that happens into something somebody decided.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "src");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (p.endsWith(".tsx") || p.endsWith(".ts")) out.push(p);
  }
  return out;
}
const FILES = sources(SRC).map((f) => ({ f, s: readFileSync(f, "utf8") }));

/** The axes a spacing step can be applied to. `space-` and `gap-` included:
 *  they are the same decision as padding, made between children instead. */
const AXIS = String.raw`(?:p|px|py|pt|pb|pl|pr|m|mx|my|mt|mb|ml|mr|gap|gap-x|gap-y|space-x|space-y)`;

/**
 * Arbitrary pixel values that are allowed to stay, each because a step cannot
 * express it.
 *
 * All five are horizontal indents that align text under something specific — a
 * glyph, a checkbox, an avatar — so the number is a measurement of that thing
 * and not a rhythm. Rounding them to the scale would misalign the very column
 * they exist to line up with.
 */
const ALLOWED_ARBITRARY = new Set(["pl-[18px]", "pl-[22px]", "pl-[30px]", "pl-[50px]", "ml-[60px]"]);

describe("spacing goes through the scale", () => {
  test("no arbitrary pixel spacing except the indents that align to a glyph", () => {
    const strays: string[] = [];
    for (const { f, s } of FILES) {
      for (const m of s.matchAll(new RegExp(String.raw`\b${AXIS}-\[[0-9]+px\]`, "g"))) {
        if (!ALLOWED_ARBITRARY.has(m[0])) strays.push(`${f.replace(SRC, "web/src")}: ${m[0]}`);
      }
    }
    // Named rather than counted: the failure has to tell whoever added one
    // where it is, or the next person just adds it to a number.
    expect(strays.join("\n") || null).toBeNull();
  });

  test("every allowed indent is still used", () => {
    // An exemption for something nobody writes any more is a note about a
    // decision that can no longer be checked.
    const all = FILES.map((x) => x.s).join("\n");
    const stale = [...ALLOWED_ARBITRARY].filter((v) => !all.includes(v)).sort();
    expect(stale.join(", ") || null).toBeNull();
  });

  test("inline spacing still lands on the grid", () => {
    /*
     * `style={{ paddingLeft: 3 }}` is what gets past every other check here: it
     * is not a class, so no scale applies, and 3 is not a number any grid
     * produces. Three of those existed when this was written.
     *
     * The rule is the GRID, not the class. Twenty-six inline values survive
     * this deliberately — `paddingLeft: 8`, `gap: 10` — and they are all even
     * and all fine: several are computed from a tree depth or a measured
     * column, which a static class cannot express. Demanding a class there
     * would push people back to arbitrary values, which is the thing this file
     * exists to stop.
     *
     * `0` is a reset rather than a measurement and is left alone.
     */
    const strays: string[] = [];
    for (const { f, s } of FILES) {
      for (const m of s.matchAll(/(padding|margin|gap)(?:Top|Bottom|Left|Right)?:\s*([0-9]+)(?![.0-9a-z%])/g)) {
        const v = Number(m[2]);
        if (v === 0 || v % 2 === 0) continue;
        strays.push(`${f.replace(SRC, "web/src")}: ${m[0]} — odd pixels are off the 2px grid`);
      }
    }
    expect(strays.join("\n") || null).toBeNull();
  });

  test("the scale is written down where the other design decisions are", () => {
    // Colours, type and shadows are all declared in the Tailwind config with a
    // reason. Spacing was the one that was not, which is how it drifted.
    const cfg = readFileSync(join(import.meta.dir, "..", "tailwind.config.js"), "utf8");
    expect(cfg).toContain("The spacing scale, written down");
    // The rule that is about meaning rather than size, and the one that was
    // actually broken in the Settings nav.
    expect(cfg).toContain("GROUP HEADING");
  });
});
