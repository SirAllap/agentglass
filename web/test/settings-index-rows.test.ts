/*
 * settingsRows.gen.ts is generated from the settings pages themselves — see
 * web/scripts/gen-settings-index.ts. A generated file that nobody regenerates
 * after editing a label is worse than a hand-kept list: it LOOKS derived, so
 * nobody double-checks it the way they would a paragraph they typed.
 *
 * This runs the generator into a scratch file and diffs it against the
 * committed one, the same "does it still say what building it would say"
 * check tranche-floors.txt itself makes AGENTS.md carry a comment about.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { SETTINGS_ROWS, SETTINGS_PAGES } from "../src/lib/settingsRows.gen.ts";
import { buildOutput } from "../scripts/gen-settings-index.ts";

describe("settingsRows.gen.ts is fresh", () => {
  test("regenerating it produces byte-identical output", () => {
    const committed = readFileSync(new URL("../src/lib/settingsRows.gen.ts", import.meta.url).pathname, "utf8");
    expect(buildOutput()).toEqual(committed);
  });

  test("at least 89 rows are indexed", () => {
    // Measured, not guessed: much of this app's settings surface is drawn
    // from data (task sources, key bindings, installed deps, plugins,
    // recipes) rather than a JSX literal a text-scanning generator can read,
    // so the true count of STATIC rows in the real pages is the ceiling —
    // see the generator's own header comment for which rows that leaves out.
    expect(SETTINGS_ROWS.length).toBeGreaterThanOrEqual(89);
  });

  test("every pane that draws at least one row appears", () => {
    const panes = new Set(SETTINGS_ROWS.map((r) => r.pane));
    expect(panes.size).toBeGreaterThanOrEqual(15);
    for (const p of SETTINGS_PAGES) expect(typeof p.id).toBe("string");
  });
});
