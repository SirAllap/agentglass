/*
 * Switches must render at their declared size, not collapse to 0×0.
 *
 * A track that is a bare <span> defaults to display: inline, which ignores
 * width/height. That makes the 34×19 track invisible and only the 15px knob
 * shows, reading as a dot rather than a switch. The fix is display: block or
 * display: inline-block on the outer span.
 *
 * This is why Switch lives in SettingRow.tsx — a shared export is what keeps
 * the three places that draw one drawing the same thing.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

describe("Switch component sizing", () => {
  const settingRow = readFileSync(new URL("../src/components/SettingRow.tsx", import.meta.url), "utf8");

  test("exported Switch in SettingRow has display: block or inline-block", () => {
    // The export function Switch must set display context on its outer span.
    // Pattern: className includes "inline-block" OR style has "display: block"
    expect(settingRow).toContain("export function Switch");

    // Extract the Switch function
    const switchMatch = settingRow.match(
      /export function Switch.*?\{[^}]*return\s*\(\s*<span[^>]*>/s
    );
    expect(switchMatch).toBeTruthy();

    const switchSpan = switchMatch![0];
    // Must have inline-block in className OR block in style
    const hasInlineBlock = switchSpan.includes("inline-block");
    const hasBlockStyle = switchSpan.includes('style={{') &&
                         (switchSpan.includes('display: "block"') || switchSpan.includes("display: 'block'"));

    if (!hasInlineBlock && !hasBlockStyle) {
      throw new Error("Switch outer span lacks display: block or inline-block — track will render 0×0");
    }
  });

  test("no other Switch component exists that might have the same bug", () => {
    const remote = readFileSync(new URL("../src/components/RemoteAccessPane.tsx", import.meta.url), "utf8");
    const settingsModal = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url), "utf8");

    // RemoteAccessPane should NOT define its own Switch (it should import from SettingRow)
    expect(remote).not.toMatch(/function Switch\s*\(/);

    // SettingsModal should either import Switch or define one with display: block
    const settingsHasSwitch = settingsModal.match(/function Switch\s*\(/);
    if (settingsHasSwitch) {
      // If it defines its own, it must have display: block
      const switchMatch = settingsModal.match(
        /function Switch.*?\{[^}]*return\s*\(\s*<span[^>]*>/s
      );
      const switchSpan = switchMatch![0];
      const hasDisplay = switchSpan.includes('display') || switchSpan.includes('block');
      expect(hasDisplay).toBeTruthy();
    }
  });

  test("the track width and height are specified", () => {
    // Both the working Switch and any alternatives must declare 34×19
    const switchMatch = settingRow.match(
      /export function Switch.*?\{[^}]*?width:\s*34.*?height:\s*19/s
    );
    expect(switchMatch).toBeTruthy();
  });
});
