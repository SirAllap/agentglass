/*
 * The Inbox rail beside the list, or above it when the panel is narrow.
 */
import { describe, expect, test } from "bun:test";
import { INBOX_RAIL_FOLDS_BELOW, railFolds } from "../src/lib/inboxLayout.ts";

const inbox = await Bun.file(new URL("../src/components/prs/Inbox.tsx", import.meta.url)).text();

describe("railFolds", () => {
  test("the widths the layout was checked at", () => {
    expect([360, 480, 540].map(railFolds)).toEqual([true, true, true]);
    expect([640, 900, 1500].map(railFolds)).toEqual([false, false, false]);
  });
  test("the boundary belongs to the beside layout", () => {
    expect(railFolds(INBOX_RAIL_FOLDS_BELOW - 1)).toBe(true);
    expect(railFolds(INBOX_RAIL_FOLDS_BELOW)).toBe(false);
  });
  test("not measured yet keeps the usual place", () => {
    expect(railFolds(0)).toBe(false);
  });
});

describe("the rail in the component", () => {
  test("is placed by the panel's measured width, and keeps its width token beside the list", () => {
    expect(inbox).toContain("railFolds(entries[0]!.contentRect.width)");
    expect(inbox).toContain("width: INBOX_RAIL_WIDTH");
  });
});

describe("a row at any width", () => {
  /** The renderRow function's own text, to its closing brace. */
  const row = inbox.slice(inbox.indexOf("const renderRow = ("), inbox.indexOf("return (\n    <div className=\"flex flex-1 min-h-0"));
  test("wraps its trailing columns under the title instead of squeezing it", () => {
    expect(row).toContain("group flex flex-wrap items-start");
    expect(row).toMatch(/min-w-\[\d+px\] flex-1 text-left/);
  });
  test("the verbs are always laid out, so hovering moves nothing", () => {
    expect(row).toContain("agx-hover-show");
    expect(row).not.toMatch(/hidden[^"]*group-hover|group-hover:(flex|block|inline)/);
  });
});
