/*
 * "Back to app" in Settings' sidebar is one button that is the whole row.
 *
 * It was a button the size of its text inside a padded bar: the bar read as
 * the control and only the arrow and the words answered the pointer.
 */
import { describe, expect, test } from "bun:test";
import { HIT } from "../src/lib/iconSize.ts";

const code = await Bun.file(new URL("../src/components/SettingsModal.tsx", import.meta.url)).text();
const css = await Bun.file(new URL("../src/index.css", import.meta.url)).text();

const asideAt = code.indexOf('<aside className="shrink-0 w-[280px]');
const aside = code.slice(asideAt, code.indexOf("</aside>", asideAt));
const strip = (t: string) => t.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/[/*].*$/gm, "");
const open = aside.indexOf("<button onClick={onClose}");
const tag = aside.slice(open, aside.indexOf(">", aside.indexOf("style={{", open)) + 1);

describe("the way out is the whole row", () => {
  test("it is the first thing in the sidebar: no padded wrapper around it to look like the control", () => {
    const before = strip(aside.slice(aside.indexOf(">") + 1, open)).trim();
    expect(open).toBeGreaterThan(-1);
    expect(before).toBe("");
  });

  test("one button holds the label and the arrow, and it spans the width", () => {
    expect(aside.slice(open, aside.indexOf("</button>", open))).toContain("Back to app");
    expect(tag).toContain("w-full");
    expect(tag).toContain('type="button"');
    expect(tag).not.toMatch(/\brounded/);
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
