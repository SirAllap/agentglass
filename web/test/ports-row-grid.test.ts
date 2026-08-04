// The list has to look like a list.
//
// Flex sized every cell from its own contents, so a row carrying two badges
// put its checkout pill at a different x than a row carrying one — and
// pointing at a row made the action buttons appear and shove everything left.
// No single row was wrong; the column had no shape, which is the same defect
// the Source control lists had.
//
// Measured after the fix with a real browser: eleven rows, six columns, 0px of
// deviation in every one, and 0 cells moving on hover. This test is the
// cheaper guard that keeps it that way.
import { describe, expect, test } from "bun:test";

// Importing the panel reaches api.ts, which reads `location` at module scope
// and throws under bun. The same shim every other web test here uses; without
// it the failure is a ReferenceError from a file this test never mentions.
(globalThis as unknown as { location: URL }).location ??= new URL("http://localhost:5173/");

const { PORT_GRID } = await import("../src/components/MachinePanel.tsx");

describe("a port row's columns are reserved, not negotiated", () => {
  /**
   * Splitting on whitespace tears `minmax(0, 1fr)` in half and reports seven
   * columns where there are six — the same mistake as splitting tmux's
   * `list-keys` output on spaces, and it fails the same way: confidently, with
   * a wrong answer rather than an error.
   */
  const cols = (() => {
    const out: string[] = [];
    let depth = 0, cur = "";
    for (const ch of PORT_GRID.trim()) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ""; continue; }
      cur += ch;
    }
    if (cur) out.push(cur);
    return out;
  })();

  test("every cell in the row has a column of its own", () => {
    // dot, port, name, flags, checkout, actions
    expect(cols).toHaveLength(6);
  });

  test("the badge and checkout columns are fixed, so they line up across rows", () => {
    // `auto` here is what let a row's contents decide where its neighbour
    // starts, which is exactly the thing being prevented.
    expect(cols[3]).toMatch(/^\d+px$/);
    expect(cols[4]).toMatch(/^\d+px$/);
  });

  test("the actions column exists whether or not the pointer is over the row", () => {
    /**
     * The one that stops the hover jump. A zero-width or conditional last
     * column would bring the defect straight back: the buttons would have
     * nowhere to go and would push the row's contents aside on appearing.
     */
    const actions = cols[5]!;
    expect(actions).toMatch(/^\d+px$/);
    expect(Number.parseInt(actions, 10)).toBeGreaterThan(0);
  });

  test("only the name column flexes", () => {
    // Everything else being fixed is what makes the columns agree; the name is
    // the one thing that should absorb a narrower window.
    expect(cols[2]).toContain("1fr");
    expect(cols.filter((c) => c.includes("fr"))).toHaveLength(1);
  });
});
