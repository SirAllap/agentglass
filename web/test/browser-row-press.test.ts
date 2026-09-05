/*
 * Why the × on a sidebar row did nothing.
 *
 * The rows drag, and dragging takes POINTER CAPTURE. Capture retargets the
 * click that follows a press: it is dispatched at the capturing element rather
 * than at whatever is under the finger — so pressing the × inside a row ran the
 * ROW's onClick (show this tab) and the button's own handler never fired at all.
 * "The X still doesn't close", twice, on two different rows.
 *
 * A source lock rather than a render: the panel mounts a Chromium guest, and
 * what is being pinned is one guard and one release, both of which are exactly
 * as findable in the source as they would be in a DOM nobody can build here.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/BrowserPanel.tsx", import.meta.url).pathname, "utf8");

describe("a press that starts on a control", () => {
  test("never becomes a drag, so the control keeps its click", () => {
    expect(src).toContain('if ((e.target as HTMLElement | null)?.closest?.("button")) return;');
  });

  test("and the capture is let go before the click is dispatched", () => {
    expect(src).toContain("node.releasePointerCapture(ev.pointerId)");
  });
});

describe("the two ×s in the sidebar", () => {
  test("are the same size, in the same reddish box", () => {
    // One glyph, one meaning, one target big enough to aim at on a row of text.
    const both = [...src.matchAll(/className="agx-x [^"]*"\s*\n?\s*style=\{\{ width: 24, height: 24 \}\}><CloseIcon size=\{ICON\.md\} \/>/g)];
    expect(both).toHaveLength(2);
  });

  test("the box is defined once, and it is not the alarm red", () => {
    const css = readFileSync(new URL("../src/index.css", import.meta.url).pathname, "utf8");
    expect(css).toContain(".agx-x {");
    // Mixed with the text colour rather than the raw error red: neither of
    // these is a mistake, and a column of alarm-coloured buttons reads as one.
    expect(css).toContain("color-mix(in srgb, var(--error) 76%, var(--text2))");
  });
});
