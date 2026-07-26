// Making a captured tmux pane readable inside a chat.
//
// `capture-pane` returns the whole terminal — the height it was given, blank
// padding, and box rules drawn to 200 columns. Shown raw, a six-line question
// arrived as a mostly-empty slab with a horizontal scrollbar. These pin the
// trimming, and just as importantly that it only ever REMOVES: this is the
// CLI's own drawing, and rewording a prompt someone is about to confirm would
// be a very bad way to be helpful.
import { test, expect } from "bun:test";
import { tidyPaneScreen, paneStillAsking } from "../src/lib/paneScreen.ts";

/** A real `/effort` frame, as captured. */
const EFFORT = [
  "",
  "",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Effort                                                       ",
  "",
  "   Faster                                    Smarter            ",
  "   low   medium   high   xhigh   max   ultracode                ",
  "",
  "   ←/→ to adjust · Enter to confirm · Esc to cancel             ",
  "",
].join("\n");

test("the padding, rules and trailing spaces go", () => {
  const out = tidyPaneScreen(EFFORT);
  expect(out.startsWith("Effort")).toBe(true);
  expect(out).not.toContain("▔");
  // Trailing spaces on every row are what produced the horizontal scrollbar.
  expect(out.split("\n").every((l) => l === l.replace(/\s+$/, ""))).toBe(true);
  expect(out.endsWith("\n")).toBe(false);
});

test("the key hints go, because the UI shows them as keys you can press", () => {
  // The same instruction twice, and the text version is the useless one.
  expect(tidyPaneScreen(EFFORT)).not.toContain("to adjust");
  expect(tidyPaneScreen(EFFORT)).not.toContain("Esc to cancel");
});

test("the question itself is never reworded", () => {
  // The one thing this must not do. Every option has to survive intact.
  const out = tidyPaneScreen(EFFORT);
  for (const level of ["low", "medium", "high", "xhigh", "max", "ultracode"]) {
    expect(out).toContain(level);
  }
  expect(out).toContain("Faster");
  expect(out).toContain("Smarter");
});

test("the shared indent is removed, not the shape", () => {
  // Every row inside a TUI box carries the same margin; dropping it buys real
  // width on a narrow panel. Relative indentation still has to survive.
  const out = tidyPaneScreen(["    Title", "      nested", "    back"].join("\n"));
  expect(out).toBe(["Title", "  nested", "back"].join("\n"));
});

test("runs of blank lines collapse to one", () => {
  // Not dropped entirely: the gap between a heading and its options is part of
  // how a picker reads.
  expect(tidyPaneScreen("a\n\n\n\n\nb")).toBe("a\n\nb");
});

test("a long frame is cut from the top, and says so", () => {
  // A picker is drawn at the bottom, so the last rows are the interesting ones.
  // Silently showing a fragment of a question is the failure to avoid.
  const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n");
  const out = tidyPaneScreen(long, 5);
  expect(out.split("\n")[0]).toContain("earlier lines");
  expect(out).toContain("line 39");
  expect(out).not.toContain("line 0\n");
});

test("still-asking is read from the frame, not from the key that was pressed", () => {
  // Enter and Escape can both end a prompt, and some pickers stay open after
  // Enter. The frame knows; the keystroke does not.
  expect(paneStillAsking("  Enter to confirm · Esc to cancel")).toBe(true);
  expect(paneStillAsking("● done\n❯ ")).toBe(false);
});
