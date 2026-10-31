/*
 * "Back to app" in Settings' sidebar is one real button with air at both sides.
 *
 * It was a bare full-bleed row: the pointer answered where the eye marked no
 * edge, so finding the spot took hunting. The shape you see is the target.
 */
import { describe, expect, test } from "bun:test";
import { HIT } from "../src/lib/iconSize.ts";

const code = await Bun.file(new URL("../src/components/SettingsNav.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

const asideAt = code.indexOf('<aside className="agx-settings-nav shrink-0');
const aside = code.slice(asideAt, code.indexOf("</aside>", asideAt));
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/[/*].*$/gm, "");
const open = aside.indexOf("<button onClick={onClose}");
const tag = aside.slice(open, aside.indexOf(">", aside.indexOf("style={{", open)) + 1);

describe("the way out is the whole row", () => {
  test("it sits in a padded wrapper, so the button has air at both sides", () => {
    expect(aside).toContain('<div className="agx-sn-backwrap shrink-0">');
    expect(css).toMatch(/\.agx-sn-backwrap\s*\{[^}]*padding:\s*12px 12px/);
  });

  test("one bordered, rounded button holds the label and the arrow, and it spans the wrapper", () => {
    expect(aside.slice(open, aside.indexOf("</button>", open))).toContain("Back to app");
    expect(tag).toContain("w-full");
    expect(tag).toContain('type="button"');
    expect(tag).toMatch(/\brounded-lg\b/);
    expect(tag).toContain("border: LINE");
  });

  test("it is at least as tall as the house hit size", () => {
    const h = Number(/minHeight:\s*(\d+)/.exec(tag)?.[1]);
    expect(h).toBeGreaterThanOrEqual(HIT);
  });

  test("hover and press answer in fill and ink only, so nothing moves", () => {
    for (const state of ["hover", "active"]) {
      const rule = new RegExp(`\\.agx-navback:${state}\\s*\\{([^}]*)\\}`).exec(css)?.[1] ?? "";
      expect(rule).toContain("background");
      expect(rule).not.toMatch(/transform|margin|padding|width|height|border|translate/);
    }
    expect(tag).toContain("agx-navback");
  });
});
