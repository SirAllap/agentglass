import { describe, expect, test } from "bun:test";

const card = await Bun.file(new URL("../src/components/PrCard.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const footer = card.slice(card.indexOf('<div className="agx-cd-f"'), card.indexOf("/* ---- stack popover ---- */"));

// Measured on the board: the footer's primary was r7 with a 14px glyph, its three squares r8 with 14, 12 and 12.
// One row of controls is one radius and one icon size.
describe("the card footer is one bar", () => {
  test("every control glyph is drawn at the same size", () => {
    /* The "Up to date" tick is a status mark inside a span, not a control. */
    const controls = footer.split("\n").filter((l) => !l.includes("agx-cd-utd")).join("\n");
    const sizes = [...controls.matchAll(/size=\{(ICON\.\w+)\}/g)].map((m) => m[1]);
    expect(new Set(sizes)).toEqual(new Set(["ICON.sm"]));
  });
  test("one radius is set on the whole row, not on part of it", () => {
    expect(css).toMatch(/\.agx-cd-f \.agx-btn \{ flex: none; border-radius: 7px; \}/);
    expect(css).not.toMatch(/\.agx-cd-f-l \.agx-btn \{[^}]*border-radius/);
  });
});
