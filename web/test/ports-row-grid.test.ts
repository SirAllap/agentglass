// The list has to look like a list.
//
// Flex sized every cell from its own contents, so a row carrying two badges
// put its checkout pill at a different x than a row carrying one, and pointing
// at a row made the action buttons appear and shove everything left. No single
// row was wrong; the column had no shape. This guards the row's grid.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const CSS = readFileSync(new URL("../src/components/machine/machineCss.ts", import.meta.url), "utf8");

/** The declaration block of one selector, or a throw: a guard that cannot find its subject must say so. */
function rule(selector: string): string {
  const at = CSS.indexOf(`${selector}{`);
  if (at < 0) throw new Error(`machineCss.ts no longer declares ${selector} — this guard needs re-aiming`);
  return CSS.slice(at, CSS.indexOf("}", at));
}

/** Splitting on whitespace tears `minmax(240px, 1fr)` in half; track on parenthesis depth. */
const tracks = (grid: string): string[] => {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of grid.trim()) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
};

const cols = tracks(/grid-template-columns:([^;]+);/.exec(rule(".mc-prow"))![1]!);

describe("a port row's columns are reserved, not negotiated", () => {
  test("every cell in the row has a column of its own", () => {
    // dot, port, name, flags, checkout, actions
    expect(cols).toHaveLength(6);
  });

  test("the checkout and actions columns are fixed, so they line up across rows", () => {
    expect(cols[4]).toMatch(/^\d+px$/);
    expect(cols[5]).toMatch(/^\d+px$/);
  });

  test("the actions column exists whether or not the pointer is over the row", () => {
    // Hidden by opacity, never by width: a zero-width column brings the hover jump back.
    expect(Number.parseInt(cols[5]!, 10)).toBeGreaterThan(0);
    expect(rule(".mc-prow .pa")).toContain("opacity:0");
    expect(rule(".mc-prow .pa")).not.toMatch(/display:none|width:0/);
  });

  test("only the name column takes a share of the free width", () => {
    expect(cols[2]).toContain("1fr");
    expect(cols.filter((c) => c.includes("fr"))).toHaveLength(1);
  });
});

describe("nothing paints outside its column", () => {
  test("the checkout cell clips and the tag is capped by its column, not by a number", () => {
    expect(rule(".mc-prow .pc")).toContain("overflow:hidden");
    expect(rule(".mc-tag[data-co=true]")).toContain("max-width:100%");
    expect(rule(".mc-tag[data-co=true]")).not.toMatch(/max-width:\d+px/);
  });

  test("the badge cell may shrink, so a long badge row wraps instead of spilling", () => {
    expect(rule(".mc-prow .pf")).toMatch(/min-width:0/);
    expect(rule(".mc-prow .pf")).toContain("flex-wrap:wrap");
  });
});
