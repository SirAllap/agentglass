/*
 * Where a card opens: beside the list, or over it.
 *
 * From the approved mockup. ClickUp offers three and he looked at all three:
 * the sidebar is what this always was and stays, the modal was the one he
 * wanted adding, and full screen was turned down — it covers the table
 * entirely, and in an app that already lives in tabs it does nothing the modal
 * does not. So the control has two positions, not three.
 */
import { describe, expect, it } from "bun:test";

const src = await Bun.file(new URL("../src/components/TasksPanel.tsx", import.meta.url)).text();

describe("opening a card", () => {
  it("offers exactly the two that were chosen", () => {
    expect(src).toContain('[["side", "Sidebar"], ["modal", "Modal"]] as const');
    /* Checked against the STORED value rather than by grepping the file for the
       words: "full screen" appears in the comment explaining why it is not
       here, and a test that trips over its own explanation is a test people
       delete. */
    expect(src).toContain('=== "modal" ? "modal" : "side"');
    expect(src).toContain('useState<"side" | "modal">');
  });

  it("builds the card once and puts it in whichever shell is chosen", () => {
    /* Two copies of the detail would be two places for a field to go stale, and
       they would drift the first time only one of them was updated. */
    expect(src.match(/<CardDetail/g)?.length).toBe(1);
    expect(src).toContain("const cardBody = (");
  });

  it("remembers the choice for the whole app, not per board", () => {
    // How you like to read a card is about you; which statuses are folded is
    // about the board.
    expect(src).toContain('const CARD_MODE_KEY = "agentglass.clickup.cardMode";');
    expect(src).not.toMatch(/filtersByBoard\.current\[leaving\] = \{[^}]*cardMode/);
  });

  it("leaves the list visible behind the modal rather than replacing it", () => {
    /* You are reading one card OUT of a list, and the list is the context that
       makes it mean anything — which is also the argument against full screen. */
    const modal = src.slice(src.indexOf('cardMode === "modal" && picked'));
    expect(modal).toContain('color-mix(in srgb, var(--bg) 62%, transparent)');
    expect(modal).toContain('role="dialog"');
  });

  it("closes on the dimmed part but not on the card itself", () => {
    // Without the stop, every click inside the card would shut it.
    const modal = src.slice(src.indexOf('cardMode === "modal" && picked'));
    expect(modal).toContain("onClick={() => setSel(null)}");
    expect(modal).toContain("onClick={(e) => e.stopPropagation()}");
  });

  it("lets Escape close the modal and ONLY the modal", () => {
    /* In the sidebar the card is part of the layout rather than something laid
       over it, and a key that empties a pane you did not open loses your
       place. */
    expect(src).toContain('if (cardMode !== "modal" || !sel) return;');
  });

  it("keeps the drag handle out of the way when there is nothing to drag", () => {
    /* A resize handle beside a modal resizes a pane nobody can see — and so
       does one beside no pane at all, which is what an empty sidebar was. */
    expect(src).toContain('{cardMode === "side" && picked && <div role="separator"');
  });

  it("covers the whole panel, bars included, not just the table", () => {
    /* As a child of the table's row it started below the board bar and the
       filter bar: a fifth of the window lit above a card that had been given
       the window. */
    expect(src).toContain('<div className="relative flex flex-col flex-1 min-h-0">');
    const modal = src.slice(src.indexOf('cardMode === "modal" && picked'));
    // The row closes BEFORE the overlay opens.
    expect(src.indexOf('{cardMode === "modal" && picked')).toBeGreaterThan(src.indexOf('</aside>'));
    expect(modal).toContain("absolute inset-0 z-30");
  });

  it("gives the card the whole height it is laid over", () => {
    /* It was content-height inside a 24px inset, so a long card left a band of
       dimmed board above and below and the reading area was the smaller half of
       a screen already given over to one card. */
    const modal = src.slice(src.indexOf('cardMode === "modal" && picked'));
    expect(modal).toContain('height: "100%", maxHeight: "100%"');
    expect(modal).toContain('flex items-stretch justify-center p-2');
  });

  it("shows a way out, and only in the modal", () => {
    /* The dimmed board and Escape were the whole exit: one is invisible, the
       other a keystroke nobody is told about. In the sidebar the card is part of
       the layout, so there is nothing to close. */
    expect(src).toContain('onClose={cardMode === "modal" ? () => setSel(null) : undefined}');
    const head = src.slice(src.indexOf('aria-label="Close the card"'));
    expect(head).toContain("var(--error)");
    // A bare glyph is a 10px target; this one carries its own box.
    expect(head).toContain("width: 26, height: 26");
  });

  it("draws no sidebar until a card is picked", () => {
    // An empty pane saying "Pick a card." spent 380px telling you to do the
    // thing you were already doing, with the width taken from the table you
    // were reading in order to choose.
    expect(src).toContain('{cardMode === "side" && picked && (\n        <aside');
  });
});
