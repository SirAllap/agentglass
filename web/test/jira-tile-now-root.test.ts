/*
 * The tile's Re-run must name the repo root the board's project maps to, as the PR detail does: an empty root reruns nothing.
 * The tile reads that root from lib/tileRoot.ts, which the Tasks panel provides; the call shape is anchored in the source.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { TileRootContext, useTileRoot } from "../src/lib/tileRoot.ts";

const tile = readFileSync(new URL("../src/components/jira/list/JiraTile.tsx", import.meta.url), "utf8");

describe("tile Re-run root", () => {
  test("the root is a context the panel provides, with no module global", () => {
    // _currentValue is a private React field; the cast reads the default value
    expect((TileRootContext as unknown as { _currentValue: unknown })._currentValue).toBe("");
    expect(typeof useTileRoot).toBe("function");
    expect(tile).toMatch(/useTileRoot\(\)/);
  });
  test("prRerun is never called with an empty root", () => {
    expect(tile).not.toMatch(/prRerun\(\s*""/);
    expect(tile).toMatch(/prRerun\(root, lead\.number\)/);
    expect(tile).toMatch(/!root\) \{ openTilePr/);
  });
  test("Fix with agent launches the conflict agent, not only the PR", () => {
    expect(tile).toMatch(/api\.prConflict\(root, lead\.number\)/);
    expect(tile).toMatch(/requestTermIssue\(/);
  });
});
