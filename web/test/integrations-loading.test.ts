/*
 * What the Integrations page shows before it knows anything.
 *
 * The page used to print one line — "Checking what is connected…" — over an
 * empty pane, then replace it with four cards. Two things were wrong with
 * that. The list of providers is a CONSTANT: it is in shared/providers.ts and
 * needs no network to draw, so there was never a reason to withhold it. And
 * the moment it appeared, everything moved.
 *
 * So the rules here are about honesty and stillness: draw what you already
 * know, say "Checking…" for what you do not, claim nothing in between, and be
 * the size you are about to be.
 */
import { describe, expect, it } from "bun:test";

const pane = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();

describe("before the answer arrives", () => {
  it("draws the providers it already knows about", () => {
    // Gated on `status &&`, the whole list waited on a fetch it did not need.
    expect(pane).not.toContain("{status && ([\"review\", \"task\"] as const).map");
    expect(pane).toContain("([\"review\", \"task\"] as const).map");
  });

  it("says Checking rather than guessing a state", () => {
    // STATE_LOOK has no entry for "we have not asked yet", so the old default
    // of "needs-auth" made every card claim "Not connected" for as long as the
    // check took — a wrong answer that then corrects itself, which is worse
    // than no answer, because somebody acts on it.
    expect(pane).toMatch(/waiting\s*\n?\s*\?\s*\{ label: "Checking…"/);
  });

  it("offers no action it cannot yet know is the right one", () => {
    // Connect, Disconnect and Change workspace are all answers to a question
    // still in flight.
    // Matched on the guard, not on what follows it: the card became a row and
    // the fragment became a div, and neither changes what is being asserted.
    expect(pane).toMatch(/\{waiting \? null : </);
  });

  it("stands in for itself at the size it will be", () => {
    expect(pane).toContain("agx-skeleton");
    // Not a hard-coded height: measured, the four cards settle at four
    // different sizes because which parts they grow depends on the very answer
    // being waited for. Each remembers its own.
    expect(pane).toContain("rememberedHeights()[spec.id]");
    expect(pane).toContain("localStorage.setItem(CARD_H_KEY");
  });

  it("measures itself only once it is real", () => {
    // Measuring while the placeholder is up would write the placeholder's
    // height in as the truth, and it would never correct itself.
    expect(pane).toMatch(/if \(waiting \|\| !box\.current\) return;/);
  });

  it("drops the min-height once the answer is in", () => {
    // Left on, it would pin a row that has since grown a line.
    expect(pane).toMatch(/waiting \? \{ minHeight: rememberedHeights\(\)/);
    expect(pane).toMatch(/: undefined\}>/);
  });
});

describe("the skeleton itself", () => {
  const css = Bun.file(new URL("../src/index.css", import.meta.url));

  it("is distinguishable from an empty box", async () => {
    const text = await css.text();
    expect(text).toContain(".agx-skeleton");
    expect(text).toContain("@keyframes agx-skeleton-sweep");
  });

  it("stops moving for anyone who asked it to", async () => {
    const text = await css.text();
    const reduced = text.slice(text.indexOf("prefers-reduced-motion: reduce"));
    expect(reduced).toContain(".agx-skeleton { animation: none");
  });
});
