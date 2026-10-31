/*
 * Where the cursor lands after the PR filter controls open.
 *
 * The defect: "Save as view…" left focus on the opener, so a typed name was
 * appended to the pre-filled one, and the deck's "Add a rule" button left focus
 * on the page body. This only asserts the fix against source, because there is
 * no renderer here; the focus itself is checked by hand in the built app.
 */
import { describe, expect, it } from "bun:test";

const bar = await Bun.file(new URL("../src/components/PrViewsBar.tsx", import.meta.url)).text();
const deck = await Bun.file(new URL("../src/components/PrFilterDeck.tsx", import.meta.url)).text();

describe("view name box", () => {
  it("is focused and selected by a stable ref, not autoFocus", () => {
    expect(bar).toContain("el?.focus(); el?.select();");
    expect(bar).toMatch(/aria-label="View name"/);
    const input = bar.slice(bar.indexOf("<input ref={focusSelect}"), bar.indexOf('aria-label="View name"'));
    expect(input).toContain("ref={focusSelect}");
    expect(input).not.toContain("autoFocus");
  });
});

describe("deck add-rule button", () => {
  it("puts the cursor in the rule input", () => {
    const at = deck.indexOf('aria-label="Pick a field"');
    const tag = deck.slice(deck.lastIndexOf("<button", at), at);
    expect(tag).toContain("inputRef.current?.focus()");
  });
});
