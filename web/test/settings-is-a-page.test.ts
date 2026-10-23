/*
 * Settings is a page, and the two things you always want stay on screen.
 *
 * It used to be a 1010px card on a scrim, and the width was a standing
 * compromise — wide enough for the Remote page's QR code and device list,
 * narrow enough to still read as a dialog. A settings screen is somewhere you
 * go, so it takes the window instead.
 *
 * Three properties are worth holding, because each one was a real failure of
 * the dialog it replaced:
 *
 *  - no scrim, and no fixed card width. Those are what made it a dialog.
 *  - the way out and the search box live OUTSIDE the scrolling nav, so a long
 *    list of pages can never push either of them off the top.
 *  - Escape asks first. One press closing the page is right for a popover and
 *    wrong for somewhere you went: the press meant for a dropdown took the
 *    whole page and its scroll position with it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const src = readFileSync(new URL("../src/components/SettingsModal.tsx", import.meta.url).pathname, "utf8");
/** Comments explain the old shape by name, so they have to come off before
 *  asserting the new one — otherwise the paragraph above a fix matches the
 *  thing it says was removed. */
const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const css = readFileSync(new URL("../src/index.css", import.meta.url), "utf8");
/** The nav lives in its own component now; the modal only mounts it. */
const navSrc = readFileSync(new URL("../src/components/SettingsNav.tsx", import.meta.url).pathname, "utf8");
const navCode = navSrc.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/^\s*\/\/.*$/gm, "");
const searchSrc = readFileSync(new URL("../src/components/SettingsSearchPanel.tsx", import.meta.url).pathname, "utf8");

describe("settings is a page", () => {
  test("no scrim and no fixed dialog width", () => {
    expect(code).not.toContain("agx-scrim");
    expect(code).not.toMatch(/w-\[\d{3,4}px\] max-w-\[96vw\]/);
  });

  test("it fills the window", () => {
    expect(code).toContain('className="agx-settings-shell fixed inset-0 flex pointer-events-auto"');
  });

  test("the nav is its own column with a fixed width, and an icon rail at a narrow window", () => {
    expect(navCode).toMatch(/<aside className="agx-settings-nav shrink-0 flex flex-col border-r"/);
    expect(code).toContain("<SettingsNav");
    expect(css).toMatch(/\.agx-settings-nav \{ width: var\(--nav-w\); \}/);
    expect(css).toMatch(/\.agx-settings-shell \{\s*--nav-w: 292px;/);
    expect(css).toMatch(/@media \(min-width: 2200px\) \{ \.agx-settings-shell \{ --nav-w: 320px; \} \}/);
    // Under 1100px the nav folds to a 68px rail: the window's minimum is 640, where a 280px nav
    // left the settings column narrower than one row. A rail keeps every page one click away.
    expect(css).toMatch(/@media \(max-width: 1100px\) \{ \.agx-settings-shell \{ --nav-w: 68px; \} \}/);
  });
});

describe("the way out and the way to search never scroll away", () => {
  /* The NAV's aside, found by its own class rather than by being the first
     one in the file. It was `indexOf("<aside")`, and the day a second aside
     went in above it — the portrait column on the clone's look editor — this
     silently started slicing the wrong element and reported that the way out
     of settings had been deleted. A landmark test that depends on source
     ORDER is a test that fails on unrelated work. */
  const at = navCode.indexOf('<aside className="agx-settings-nav shrink-0');
  const aside = navCode.slice(at, navCode.indexOf("</aside>", at));

  test("both sit above the scrolling list", () => {
    const back = aside.indexOf("Back to app");
    const search = aside.indexOf("{search}");
    const scroller = aside.indexOf("overflow-y-auto");
    expect(searchSrc).toContain('placeholder="Search settings"');
    expect(code).toMatch(/search=\{\s*<SettingsSearchPanel/);
    expect(back).toBeGreaterThan(-1);
    expect(search).toBeGreaterThan(back);
    expect(scroller).toBeGreaterThan(search);
  });

  test("leaving is a labelled button, not an x", () => {
    const at = aside.indexOf("<button onClick={onClose}");
    expect(at).toBeGreaterThan(-1);
    expect(aside.slice(at, aside.indexOf("</button>", at))).toContain("Back to app");
  });
});

describe("escape asks before it leaves", () => {
  test("the first press arms and the second closes", () => {
    const from = code.indexOf('if (e.key !== "Escape") return;');
    expect(from).toBeGreaterThan(-1);
    const handler = code.slice(from, code.indexOf("};", from));
    expect(handler).toContain("if (escArmed) { setEscArmed(false); onClose(); return; }");
    expect(handler).toContain("setEscArmed(true)");
  });

  test("the arming lapses on its own", () => {
    expect(code).toMatch(/setTimeout\(\(\) => setEscArmed\(false\), ESC_CONFIRM_MS\)/);
    expect(code).toMatch(/const ESC_CONFIRM_MS = \d+;/);
  });

  test("and it says what the second press does", () => {
    expect(code).toContain("Press Escape again to leave settings");
  });
});
