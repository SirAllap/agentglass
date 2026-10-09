/*
 * What looks pressable on the ClickUp page, outside the workflow map, is, and
 * what does not do anything does not look pressable.
 *
 * The switch for "Changes in <tracker>" was a 19px track with no hover or press
 * answer, the folding cards ("What we found", "Advanced") answered nothing but a
 * cursor, and the outlined pills in the mock cards under "Where this shows up"
 * were drawn like the controls they imitate.
 */
import { describe, expect, test } from "bun:test";
import { HIT } from "../src/lib/iconSize.ts";

const pane = await Bun.file(new URL("../src/components/ClickUpPane.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();
const rule = (sel: string) => new RegExp(`${sel.replace(/[.:>()*]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";

describe("the changes switch", () => {
  const at = pane.indexOf('role="switch"');
  const tag = pane.slice(pane.lastIndexOf("<button", at), pane.indexOf(">", pane.indexOf("style=", at)) + 1);

  test("its button is padded to the house hit size, not the 19px track", () => {
    expect(tag).toContain("agx-switch-hit");
    expect(tag).toContain("minHeight: HIT");
    expect(HIT).toBeGreaterThan(19);
  });

  test("the track answers hover and press, and a disabled switch does neither", () => {
    expect(rule(".agx-switch-hit:hover:not(:disabled) > span")).toContain("filter");
    expect(rule(".agx-switch-hit:active:not(:disabled) > span")).toContain("filter");
    expect(rule(".agx-switch-hit:disabled")).toContain("cursor: default");
  });
});

describe("the folding cards", () => {
  test("the header bar is the target, with hover and press from the same tokens as the rest", () => {
    expect(pane).toContain("agx-settings-head agx-fold");
    expect(rule(".agx-fold")).toContain("cursor: pointer");
    expect(rule(".agx-fold:hover")).toContain("--text");
    expect(rule(".agx-fold:active")).toContain("--text");
  });
});

describe("every Button has a pressed state", () => {
  test("pressed is darker than hover, and not for a disabled one", () => {
    expect(rule(".agx-btn:active:not(:disabled)")).toMatch(/brightness\(0\.\d+\)/);
  });
});

describe("a drawing of a pill is not drawn like a control", () => {
  const chip = pane.slice(pane.indexOf("const Chip2 ="), pane.indexOf("function PrView("));
  test("no outline, and the pointer stays an arrow", () => {
    expect(chip).not.toContain("border");
    expect(chip).not.toContain("EDGE");
    expect(chip).toContain("cursor-default");
  });
});
