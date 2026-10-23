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

  // The track is drawn by `.agx-switch` in index.css now (the look moved to tokens
  // with the kit); the claim is the same: a display context and a size.
  const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
  const track = css.match(/\.agx-switch \{[^}]*\}/)?.[0] ?? "";

  test("exported Switch in SettingRow draws the track class, and the class has display: inline-block", () => {
    expect(settingRow).toContain("export function Switch");
    const sw = settingRow.slice(settingRow.indexOf("export function Switch"));
    expect(sw.slice(0, sw.indexOf("</span>\n  );"))).toContain('className="agx-switch"');
    if (!/display:\s*(inline-)?block/.test(track)) {
      throw new Error("`.agx-switch` lacks display: block or inline-block — track will render 0×0");
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
    expect(track).toMatch(/width:\s*35px/);
    expect(track).toMatch(/height:\s*20px/);
  });
});
