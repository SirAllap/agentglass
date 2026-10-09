/*
 * A pull request is pinned with a tack, not starred.
 *
 * The star read as "favourite" and sat beside the copy-number and link buttons
 * as if it were one; pinning to the bar is a different act. Skill favourites
 * in the command bar and the chat panel really are favourites and keep theirs.
 * A rule about source is asserted against source: there is no renderer here.
 */
import { describe, expect, it } from "bun:test";

const board = await Bun.file(new URL("../src/components/TriageBoard.tsx", import.meta.url)).text();
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const glyphs = await Bun.file(new URL("../src/lib/glyphIcons.tsx", import.meta.url)).text();

/** Comments out, so a word in prose does not satisfy or fail a guard. */
const code = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");

describe("pull request pins use the tack", () => {
  it("neither the board nor the panel draws a star", () => {
    expect(code(board)).not.toContain("StarIcon");
    expect(code(panel)).not.toContain("StarIcon");
  });

  it("the card button, the row button and the panel button draw a tack, filled when pinned", () => {
    expect(code(board)).toContain("<PinIcon size={ICON.xs} filled={pinned} />");
    expect(code(panel)).toContain("<PinIcon size={ICON.sm} filled={pinned} />");
    expect(code(panel)).toContain("<PinIcon size={ICON.xs} filled={currentPinned} />");
  });

  it("the tack can be filled", () => {
    expect(glyphs).toContain("export function PinIcon({ size = ICON.sm, className, filled }");
  });
});

describe("the board no longer lists pins", () => {
  /*
   * A "Pinned" list at the foot of the first lane sat under "Needs your
   * review" and had nothing to do with it. The pins live in the bar at the top
   * of the panel, which is where they are reachable from every view.
   */
  it("TriageBoard has no pinned strip and takes no pinned list", () => {
    const src = code(board);
    expect(src).not.toContain("PinnedStrip");
    expect(src).not.toContain("pinnedList");
  });

  it("PrPanel does not hand the board a pinned list", () => {
    expect(code(panel)).not.toContain("pinnedList");
  });
});

describe("the pinned bar", () => {
  /** The capsule's own source, to its closing brace. */
  const capsule = (() => {
    const a = panel.indexOf("function PinnedCapsule(");
    // The capsule and the scroller under it: the chips live in the second.
    const b = panel.indexOf("\n}\n", panel.indexOf("function PinScroller(", a));
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBeGreaterThan(a);
    return code(panel.slice(a, b));
  })();

  it("labels the bar with the tack, not the word", () => {
    expect(capsule).toContain('aria-label="Pinned"');
    expect(capsule).not.toMatch(/uppercase tracking-wider[^\n]*>\s*Pinned/);
  });

  it("a chip opens in the app and shows the number, the cut title and the whole title on hover", () => {
    expect(capsule).toContain("onOpen(p.number)");
    expect(capsule).toContain("${p.title}`}");
    expect(capsule).toContain("truncate");
  });

  it("marks the open chip as current", () => {
    expect(capsule).toContain('aria-current={open ? "page" : undefined}');
  });

  it("unpin is its own button in a slot that is always there, revealed by opacity", () => {
    expect(capsule).toContain("aria-label={`Unpin #${p.number}`}");
    expect(capsule).toMatch(/opacity-0[^"]*group-hover:opacity-100[^"]*focus:opacity-100/);
    // Visibility must never be a display toggle: that would shift the chip.
    expect(capsule).not.toMatch(/hidden group-hover|group-hover:(inline|block|flex)/);
  });

  it("scrolls sideways under the header instead of wrapping over it", () => {
    expect(capsule).toContain("overflow-x-auto");
    expect(capsule).toContain('maxWidth: "40%"');
    expect(capsule).not.toContain("flex-wrap");
  });
});
