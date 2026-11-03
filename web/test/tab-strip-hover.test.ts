/*
 * The tab is hot on the frame the pointer arrives.
 *
 * Measured on the compiled bundle with a real pointer (Input.dispatchMouseEvent
 * over CDP, five windows): `:hover` matched at 30 ms, but the tab did not LOOK
 * hovered until 195-213 ms, and a click set `aria-selected` at 8-15 ms while the
 * selected look took 173-198 ms. The cause was the 150 ms `transition-colors`
 * on the tab and the `transition-opacity` on its close x: the state arrived at
 * once and the paint trailed it, which reads as a click that was ignored.
 *
 * These are source-level assertions: the strip mounts xterm and a socket, and
 * none of that stands up in a test runner. The rule they protect is the one the
 * owner asked for — hover and selection on the same frame, and the hover tooltip
 * (the peek card) never between the pointer and the tab.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = (f: string) => readFileSync(new URL(`../src/components/${f}`, import.meta.url).pathname, "utf8");
const tab = src("terminal/WindowTab.tsx");
const peek = src("terminal/PeekCard.tsx");

/** The class list of the element whose template literal starts at `marker`. */
function classes(marker: string): string {
  const at = tab.indexOf(marker);
  if (at < 0) throw new Error(`no element for ${marker}`);
  const open = tab.lastIndexOf("`", at);
  const close = tab.indexOf("`", at);
  if (open < 0 || close < 0) throw new Error(`no template literal for ${marker}`);
  return tab.slice(open + 1, close);
}

describe("the tab is hot at once", () => {
  test("no colour ramp on the tab itself", () => {
    const root = classes("group relative flex items-center");
    expect(root).not.toContain("transition");
    // The hover look is still there — this is a ramp removed, not a state.
    expect(root).toContain("hover:bg-[var(--surface-inset)]");
  });

  test("no opacity ramp on the close x", () => {
    const x = classes("shrink-0 group-hover:opacity-100");
    expect(x).not.toContain("transition");
    expect(x).toContain("group-hover:opacity-100");
  });

  test("nothing in the tab waits for a timer or an entry event", () => {
    expect(tab).not.toContain("setTimeout");
    expect(tab).not.toContain("onMouseEnter");
    expect(tab).not.toContain("onPointerEnter");
  });

  test("the tooltip cannot stand between the pointer and the tab", () => {
    // A portal, drawn under the pointer, and it takes no events.
    expect(peek).toContain('pointerEvents: "none"');
    expect(peek).toContain("<Portal");
  });
});
