/*
 * The menu the right button was not producing.
 *
 * A `<webview>` has no context menu of its own — Chromium's belongs to the
 * browser around the page, and here that browser is this app. What is worth
 * pinning is not that a menu appears (that needs a pointer and a screen) but
 * WHICH items each click produces: a link and a paragraph are different menus,
 * and every url in one of them came from a page this app did not write.
 */
import { describe, expect, test } from "bun:test";
// @ts-expect-error - CommonJS, no types, same as the guard's own test
import { browserMenuTemplate } from "../../electron/browser-menu.js";
// @ts-expect-error - the real one, so the test cannot drift from what ships
import { safeGuestUrl } from "../../electron/guest-guard.js";

type Item = { label?: string; role?: string; type?: string; enabled?: boolean; click?: () => void };

const calls: Record<string, unknown[]> = {};
const on = new Proxy({} as Record<string, (v?: unknown) => void>, {
  get: (_t, name: string) => (v?: unknown) => { (calls[name] ??= []).push(v); },
});

const build = (params: Record<string, unknown>, ctx: Record<string, unknown> = {}): Item[] => {
  for (const k of Object.keys(calls)) delete calls[k];
  return browserMenuTemplate(params, { safeUrl: safeGuestUrl, pageUrl: "https://example.com/page", on, ...ctx });
};
const labels = (items: Item[]) => items.filter((i) => i.label).map((i) => i.label!);
const press = (items: Item[], label: string) => items.find((i) => i.label?.startsWith(label))?.click?.();

describe("a right click on the page itself", () => {
  const items = build({});
  test("offers where you can go and what this page is, and nothing about links", () => {
    expect(labels(items)).toEqual([
      "Back", "Forward", "Reload",
      "Copy this page's address", "Open this page in your own browser",
      "Inspect",
    ]);
  });

  test("back and forward are DISABLED rather than missing, so they never move", () => {
    const nav = items.filter((i) => i.label === "Back" || i.label === "Forward");
    expect(nav.map((i) => i.enabled)).toEqual([false, false]);
    expect(build({}, { canBack: true }).find((i) => i.label === "Back")?.enabled).toBe(true);
  });
});

describe("a right click on a link", () => {
  const items = build({ linkURL: "https://orbit.example/issues/7" });

  test("puts the link's own items first", () => {
    expect(labels(items).slice(0, 3)).toEqual([
      "Open link in a new tab", "Copy link address", "Open link in your own browser",
    ]);
  });

  test("opening it asks for a tab, with the address the page gave", () => {
    press(items, "Open link in a new tab");
    expect(calls.openTab).toEqual(["https://orbit.example/issues/7"]);
  });

  /*
   * The page wrote this url, so the menu does not trust it. `javascript:` and
   * `file:` are the two that matter: one would run in whatever tab it landed
   * in, the other would read the disk of the person who right-clicked.
   */
  test("a link the guard refuses is not offered at all", () => {
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,<b>x"]) {
      expect(labels(build({ linkURL: bad }))).not.toContain("Open link in a new tab");
    }
  });
});

describe("a right click on an image", () => {
  const items = build({ mediaType: "image", srcURL: "https://orbit.example/logo.png" });
  test("offers the three things you do with one", () => {
    expect(labels(items).slice(0, 3)).toEqual(["Open image in a new tab", "Copy image", "Copy image address"]);
  });
  test("and copying it goes through Chromium, which has the decoded bitmap", () => {
    press(items, "Copy image");
    expect(calls.copyImage).toHaveLength(1);
  });
});

describe("a right click on a selection", () => {
  test("offers copy and a search, with the engine chosen elsewhere", () => {
    const items = build({ selectionText: "  routing calls that already ended  " });
    expect(items.some((i) => i.role === "copy")).toBe(true);
    press(items, "Search the web for");
    // Trimmed, and it is the TEXT that travels: which engine to use is a
    // setting, and the setting lives in the app rather than in the shell.
    expect(calls.search).toEqual(["routing calls that already ended"]);
  });

  test("a long selection is elided in the label and whole in the search", () => {
    const long = "x".repeat(200);
    const items = build({ selectionText: long });
    const label = labels(items).find((l) => l.startsWith("Search the web for"))!;
    expect(label).toContain("…");
    expect(label.length).toBeLessThan(60);
    press(items, "Search the web for");
    expect((calls.search[0] as string).length).toBe(200);
  });

  test("but an editable box gets the editing menu instead — searching a half-typed comment is the wrong offer", () => {
    const items = build({ isEditable: true, selectionText: "half a sent" });
    expect(items.filter((i) => i.role).map((i) => i.role)).toEqual(["cut", "copy", "paste", "selectAll"]);
    expect(labels(items)).not.toContain("Search the web for “half a sent”");
  });
});
