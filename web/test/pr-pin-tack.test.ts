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
    // The one star is "follow this colleague" on the person banner, which pins nothing.
    const banner = code(board).slice(code(board).indexOf("export function PersonBanner("));
    expect(code(board).replace(banner, "").replace(/import \{[^}]*\} from "..\/lib\/glyphIcons.tsx";/, "")).not.toContain("StarIcon");
    expect(code(panel)).not.toContain("StarIcon");
  });

  it("the card button and the panel button draw a tack, filled when pinned", () => {
    expect(code(board)).toContain("<PinIcon size={ICON.xs} filled={pinned} />");
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

describe("the pin button", () => {
  it("is labelled with the tack, not the word, and counts the pins", () => {
    const a = panel.indexOf("function PinMenu(");
    const menu = code(panel.slice(a, panel.indexOf("\n}\n", a)));
    expect(menu).toContain("<PinIcon size={BAR_ICON}");
    expect(menu).toContain("Pinned pull requests (${pinned.length})");
  });
});
