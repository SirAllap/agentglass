import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { rowCenterDelta, shouldRealign, scrollIsOurs, ROW_PIN_STABLE_MS } from "../src/components/settings/shell/PageRail.tsx";

const modal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

describe("a row jump keeps its row centered while the page grows", () => {
  // Scroller 600 px tall at top 0; row 40 px tall, centered when its top is at 280.
  test("centered row needs no move", () => {
    expect(rowCenterDelta(280, 40, 0, 600)).toBe(0);
  });
  test("page grows 1000 px above the row: the realign is allowed and its delta lands the row", () => {
    const delta = rowCenterDelta(280 + 1000, 40, 0, 600);
    expect(delta).toBe(1000);
    expect(shouldRealign(true, false, delta, 0, 0)).toBe(true); // our own jump, no foreign scroll yet
    expect(rowCenterDelta(280 + 1000 - delta, 40, 0, 600)).toBe(0);
  });
  test("after a scroll that was not ours, a row far from the middle is not pulled back", () => {
    expect(shouldRealign(true, true, 1000, 0, 0)).toBe(false);
  });
  test("input releases: an unpinned rail never realigns", () => {
    expect(shouldRealign(false, false, 1000, 0, 0)).toBe(false);
  });
  test("the rail's own scroll chain is still ours", () => {
    expect(scrollIsOurs(1100, 1000, -Infinity)).toBe(true);
    expect(ROW_PIN_STABLE_MS).toBe(500);
  });
  test("the modal pins a row through the rail, with no one-shot scroll and no trace", () => {
    expect(modal).toContain("PIN_ROW_EVENT");
    expect(modal).not.toContain("agxjump");
  });
});
