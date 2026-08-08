// Which box a jump in the PR files tab is supposed to move.
//
// The bug this locks: clicking a code-search result did nothing at all. The
// jump asked for `closest(".agx-scroll")`, and `.agx-scroll` is only the app's
// scrollbar skin — in split view each half of a diff wears it too, and those
// panes scroll sideways. So the nearest one to a matched LINE was a pane with
// nothing to scroll vertically, and every `scrollTop` written to it was a
// silent no-op. Measured in a real browser: the row for the match existed, sat
// 300px below the fold, and the page never moved a pixel. A file card's nearest
// `.agx-scroll` IS the page, which is why jumping to a file worked and jumping
// to a line inside that same file did not.
import { test, expect } from "bun:test";
import { verticalScrollerOf, type ScrollBox } from "../src/lib/prNav.ts";

/** A stand-in for a DOM chain: the suite has no browser, and this rule only
 *  ever reads three numbers and a word per ancestor. */
type Box = ScrollBox & { name: string; overflowY: string; parentElement: Box | null };
const box = (name: string, o: { h?: number; content?: number; overflowY?: string }, parent: Box | null = null): Box => ({
  name,
  clientHeight: o.h ?? 100,
  scrollHeight: o.content ?? o.h ?? 100,
  overflowY: o.overflowY ?? "visible",
  parentElement: parent,
});
const scroller = (el: Box) => verticalScrollerOf(el, (e) => e.overflowY);

test("a sideways pane is not the scroller, however tall the page above it is", () => {
  // The exact shape of the split diff: page → file card → split pane → row.
  const page = box("page", { h: 800, content: 4000, overflowY: "auto" });
  const card = box("card", { h: 1200, content: 1200, overflowY: "clip" }, page);
  const pane = box("split pane", { h: 1144, content: 1144, overflowY: "auto" }, card);
  const row = box("row", { h: 19 }, pane);
  expect(scroller(row)?.name).toBe("page");
});

test("the clipped file card never wins, even holding more than it shows", () => {
  // `overflow: clip` is what keeps the card's rounded corners without making it
  // a scroll container. It still reports more content than height.
  const page = box("page", { h: 800, content: 4000, overflowY: "auto" });
  const card = box("card", { h: 300, content: 1200, overflowY: "clip" }, page);
  const row = box("row", { h: 19 }, card);
  expect(scroller(row)?.name).toBe("page");
});

test("a hidden ancestor is not offered either", () => {
  const page = box("page", { h: 800, content: 4000, overflowY: "auto" });
  const wrap = box("wrap", { h: 300, content: 1200, overflowY: "hidden" }, page);
  expect(scroller(box("row", { h: 19 }, wrap))?.name).toBe("page");
});

test("the nearest scrolling ancestor wins when there really is one", () => {
  const page = box("page", { h: 800, content: 4000, overflowY: "auto" });
  const inner = box("inner", { h: 200, content: 900, overflowY: "scroll" }, page);
  expect(scroller(box("row", { h: 19 }, inner))?.name).toBe("inner");
});

test("a page with nothing to scroll has no scroller — and no jump to make", () => {
  const page = box("page", { h: 800, content: 800, overflowY: "auto" });
  expect(scroller(box("row", { h: 19 }, page))).toBe(null);
});

test("a one-pixel overshoot is rounding, not a scrollbar", () => {
  // Sub-pixel layout leaves scrollHeight a hair over clientHeight all over the
  // place; treating that as scrollable would hand back the first wrapper.
  const page = box("page", { h: 800, content: 4000, overflowY: "auto" });
  const wrap = box("wrap", { h: 300, content: 301, overflowY: "auto" }, page);
  expect(scroller(box("row", { h: 19 }, wrap))?.name).toBe("page");
});
