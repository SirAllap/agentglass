/*
 * Surfaces are painted with the surface tokens, and the count of anything
 * else only goes down.
 *
 * `index.css` names the levels — `--surface-card` for a card, panel, dialog
 * or popover body, `--surface-inset` for a well that sits inside one and takes
 * input — and an audit counted six views using them against every other view
 * painting `var(--bg2)` straight onto its cards. `--surface-card` IS `bg2`
 * today, so those looked identical; the difference is that a card spelled
 * `--bg2` never moves when the card level does, and a text box spelled `--bg2`
 * lands on its card at the card's own tone and reads as unstyled rather than
 * inset.
 *
 * A ratchet rather than a ban, with the ceiling in `ratchets.txt`: the count
 * must not rise above it and must not sit below it either, so the commit that
 * lowers the count lowers the line and the freed room cannot be spent again.
 *
 * What is counted is a DIRECT fill — `var(--bg2)` as the whole value of
 * `background`/`backgroundColor` (or one arm of a ternary). A `color-mix()`
 * that uses bg2 as an ingredient is a tint, not a surface, and is not counted.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = new URL("../src", import.meta.url).pathname;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

function stripComments(src: string): string {
  // Newlines kept, so a line number in the failure message is a real one.
  return src.replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, (c) => c.replace(/[^\n]/g, "")).replace(/^[ \t]*\/\/.*$/gm, "");
}

const files = sourceFiles(SRC);
const sources = new Map(await Promise.all(files.map(async (f) => [f, stripComments(await Bun.file(f).text())] as const)));
const ceilings = new Map(
  (await Bun.file(new URL("./ratchets.txt", import.meta.url)).text())
    .split("\n").filter((l) => l.trim() && !l.startsWith("#"))
    .map((l) => { const [k, n] = l.trim().split(/\s+/); return [k!, Number(n)] as const; }),
);

/**
 * Every direct `var(--bg2)` fill in `src`, with its offset.
 *
 * A value is read from `background:` to the first `,` `;` `}` or newline that
 * is not inside parentheses — so a ternary whose other arm is a `color-mix()`
 * full of commas is still one value — and counts when bg2 appears in it as a
 * whole quoted token (`"var(--bg2)"`) or as the whole CSS value
 * (`background: var(--bg2);`). A `color-mix()` that uses bg2 as an ingredient
 * is a tint, not a surface, and is not counted.
 */
export function bg2Fills(src: string): number[] {
  const at: number[] = [];
  for (const m of src.matchAll(/background(?:Color)?:/g)) {
    const from = m.index! + m[0].length;
    let depth = 0, i = from;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      else if (depth === 0 && (c === "," || c === ";" || c === "}" || c === "\n")) break;
      if (depth < 0) break;
    }
    const value = src.slice(from, i);
    if (/["'`]var\(--bg2\)["'`]/.test(value) || /^\s*var\(--bg2\)\s*$/.test(value)) at.push(m.index!);
  }
  return at;
}

describe("surface ratchet", () => {
  test("bg2 as a direct fill never grows, and its ceiling follows it down", () => {
    const ceiling = ceilings.get("bg2-fill");
    expect(ceiling).toBeNumber();
    const where: string[] = [];
    for (const [f, src] of sources) {
      for (const i of bg2Fills(src)) where.push(`${f.slice(SRC.length + 1)}:${src.slice(0, i).split("\n").length}`);
    }
    const n = where.length;
    if (n > ceiling!) throw new Error(`${n} direct var(--bg2) fills, ceiling ${ceiling}. Paint cards with var(--surface-card) and wells with var(--surface-inset):\n${where.join("\n")}`);
    if (n < ceiling!) throw new Error(`${n} direct var(--bg2) fills, below the ceiling of ${ceiling}: lower bg2-fill in web/test/ratchets.txt to ${n}.`);
    expect(n).toBe(ceiling!);
  });

  test("the pattern sees each form it is meant to", () => {
    // Break-it-on-purpose, kept: a pattern that silently matches nothing turns
    // this whole file into a pass.
    const hits = (s: string) => bg2Fills(s).length;
    expect(hits(`style={{ background: "var(--bg2)", color: "x" }}`)).toBe(1);
    expect(hits(`style={{ backgroundColor: 'var(--bg2)' }}`)).toBe(1);
    expect(hits(`background: on ? "var(--bg2)" : "transparent"`)).toBe(1);
    expect(hits(`background: on ? "color-mix(in srgb, var(--x) 10%, var(--bg2))" : "var(--bg2)",`)).toBe(1);
    expect(hits("el.style.cssText = `background: var(--bg2); color: red`")).toBe(1);
    expect(hits(`background: "color-mix(in srgb, var(--bg2) 40%, transparent)"`)).toBe(0);
    expect(hits(`style={{ color: "var(--bg2)", background: "var(--primary)" }}`)).toBe(0);
    expect(hits(`style={{ background: "var(--primary)", color: "var(--bg2)" }}`)).toBe(0);
  });
});
