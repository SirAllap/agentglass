/*
 * The setting chip has to be found. Measured: the person looked for it and did
 * not see it, bottom left over the terminal, and a Git view's 22 px shortcut bar
 * ran under its edge. These pin how long it stays and where it sits; the look
 * (the shared card, the title line) was checked in the rendered app, light and
 * dark.
 */
import { describe, expect, it } from "bun:test";
import { CHIP_BOTTOM, CHIP_MS } from "../src/lib/quietPresent.ts";

describe("the setting chip stays long enough to be found", () => {
  it("is on screen for at least a minute", () => {
    expect(CHIP_MS).toBeGreaterThanOrEqual(60_000);
  });

  it("sits above the 22 px shortcut bar the Git view draws at the bottom edge", async () => {
    expect(CHIP_BOTTOM).toBeGreaterThanOrEqual(22 + 16);
    const chip = await Bun.file(new URL("../src/components/AgentChangeChip.tsx", import.meta.url)).text();
    expect(chip).toContain("bottom: CHIP_BOTTOM");
  });

  it("is drawn on the shared agent card, whose border and shadow are house tokens, not a new colour", async () => {
    const chip = await Bun.file(new URL("../src/components/AgentChangeChip.tsx", import.meta.url)).text();
    expect(chip).toContain("...AGENT_CARD");
    expect(chip).toContain("style={AGENT_BTN}");
    const card = await Bun.file(new URL("../src/components/AgentOffers.tsx", import.meta.url)).text();
    const def = card.slice(card.indexOf("export const AGENT_CARD"), card.indexOf("export const AGENT_BTN"));
    expect(def).toContain("var(--surface-card)");
    expect(def).toContain("var(--primary)");
    // The one literal is the lift the update card already uses; no colour number of its own.
    expect(def.replaceAll("#000a", "")).not.toMatch(/#[0-9a-fA-F]{3,8}|rgb\(/);
  });
});
