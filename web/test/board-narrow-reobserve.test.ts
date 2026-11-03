/*
 * The board's width observer follows the scroller, not the first one.
 *
 * Opening Closed unmounts the lanes' scroller; the observer then read width 0
 * and left `narrowBoard` true, so "Back to the board" drew one lane. The effect
 * must re-run when the results view toggles.
 */
import { expect, test } from "bun:test";

const src = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();

test("the narrow-board observer re-attaches when the results view toggles", () => {
  const at = src.indexOf("new ResizeObserver(() => { setNarrowBoard(");
  expect(at).toBeGreaterThan(0);
  const tail = src.slice(at, src.indexOf("const cols = useMemo(", at));
  expect(tail).toContain("[!!results,");
});
