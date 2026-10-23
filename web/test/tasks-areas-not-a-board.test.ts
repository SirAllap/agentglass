import { expect, test } from "bun:test";

/*
 * The Areas rail reads once per board visit. On a view that is not a board (a
 * saved filter, "assigned to me") the effect set "loading" and returned with no
 * read to follow, so the rail sat on "Reading the areas…" for good. There is no
 * renderer here, so the rule is asserted against the source: the early return
 * for a non-board view settles the state on the same line.
 */
const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

test("a view that is not a board settles the Areas state instead of leaving it loading", () => {
  const at = src.indexOf('if (!source.boardAreas || !boardViewId?.startsWith("board:"))');
  expect(at).toBeGreaterThan(0);
  const line = src.slice(at, src.indexOf("\n", at));
  expect(line).toContain('setAreas({ state: "ready", read: null })');
});
