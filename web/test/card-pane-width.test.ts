/*
 * How wide the card pane is.
 *
 * It was a boolean behind a `narrow` / `wider` button: two widths, 380 and 720,
 * nothing between them. Chosen from a mockup he approved — the pane is dragged
 * by its edge, and the button goes, because a drag does its whole job. What was
 * worth keeping is its one good property, getting back to the usual width in a
 * single press, which is now the double-click on the handle.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("dragging the card pane", () => {
  it("retires the two-state button", () => {
    // Two controls for one dimension is two places to disagree about it.
    expect(src).not.toContain("⇥ narrow");
    expect(src).not.toContain("⇤ wider");
  });

  it("keeps the width in pixels, not as a flag", () => {
    expect(src).toContain("const [cardW, setCardW] = useState");
    expect(src).toContain("style={{ width: cardW,");
  });

  it("remembers it for the whole app rather than per board", () => {
    /* The opposite of the folds and the filters, which are per board because a
       board is a place. A width is about your screen. */
    expect(src).toContain('const CARD_W_KEY = "agentglass.clickup.cardWidth";');
    expect(src).not.toMatch(/filtersByBoard\.current\[leaving\] = \{[^}]*cardW/);
  });

  it("reads the old setting once, so nobody who liked it wide arrives narrow", () => {
    expect(src).toContain('localStorage.getItem(WIDE_KEY) === "1" ? 720 : CARD_W_DEFAULT');
  });

  it("holds both ends, because past either the layout stops working", () => {
    /* The floor is readability and does not move: under 280 the card stops being one.
       The ceiling was a flat 720, which on a 2000px screen is the app refusing the room
       it has — reported as "I cannot drag it wider", with the grip working perfectly.
       What that ceiling protects is the TABLE, so it is measured from the window and
       leaves the list its own 420. */
    expect(src).toContain("window.innerWidth - 420");
    expect(src).toContain("Math.max(280, Math.min(max, Math.round(w)))");
    // Still bounded at both ends, and still usable in a headless render.
    expect(src).toContain("Math.max(720, Math.min(1400, room))");
    expect(src).toContain('typeof window === "undefined" ? 1100');
  });

  it("measures against the window edge instead of adding up deltas", () => {
    /* A drag that accumulates drifts away from the pointer the moment one move
       event is dropped, and it never catches up. */
    expect(src).toContain("setCardW(clampCardW(right - ev.clientX))");
  });

  it("gives back the one-press return the button used to have", () => {
    expect(src).toContain("onDoubleClick={() => setCardW(CARD_W_DEFAULT)}");
  });

  it("can be driven from the keyboard, since it is a real control", () => {
    expect(src).toContain('aria-orientation="vertical"');
    expect(src).toContain('e.key === "ArrowLeft"');
  });

  it("answers the card's own two-column question from the pixels", () => {
    // Not a second stored flag that can disagree with the width beside it.
    expect(src).toContain("cardW >= 560");
    expect(src).not.toMatch(/const \[wide, setWide\]/);
  });

  /*
   * The two shells, asked the same question.
   *
   * "Have I got room for two columns" was answered from the SIDEBAR's width in
   * both of them, so a card in the modal — nine tenths of a 2000px screen —
   * laid itself out as a narrow column whenever the pane behind it happened to
   * be dragged small. The kind of thing only a side-by-side comparison finds.
   */
  it("asks the modal about the modal, not about the pane behind it", () => {
    expect(src).toContain('const wide = cardMode === "modal" || cardW >= 560;');
  });
});
