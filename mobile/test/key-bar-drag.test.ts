/*
 * The key bar's rows drag. The model is in key-layout.test.ts; this is the
 * screen reaching it — a handle nobody wired is a grip that does nothing, and
 * a page that keeps scrolling under the finger ends every drag half way.
 * A rule about source is asserted against source: there is no renderer here.
 */
import { describe, expect, test } from "bun:test";

const src = (await Bun.file(new URL("../app/terminal-settings.tsx", import.meta.url)).text())
  .split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*") && !l.trim().startsWith("/*")).join("\n");

describe("the Key bar screen", () => {
  test("a drop moves the key through the model", () => {
    expect(src).toContain("moveTo(layout, catalogue, row.key.id, to)");
  });

  test("the page stops scrolling while a row is held", () => {
    expect(src).toContain("scrollEnabled={!dragging}");
    expect(src).toContain("onHold={setDragging}");
  });

  test("the gesture is not handed to the scroll view", () => {
    const at = src.indexOf("function DragRow(");
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at)).toContain("onPanResponderTerminationRequest: () => false");
  });

  test("only keys on the bar draw a handle, and the arrows are still there", () => {
    expect(src).toContain("draggable={row.shown}");
    expect(src).toContain("Move ${row.key.spoken} earlier");
  });
});
