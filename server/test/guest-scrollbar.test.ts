/*
 * A page in the built-in browser drew Chromium's stock light-grey scrollbar
 * next to a dark app. The decision — which colours, for which theme, put on a
 * page when it loads and again when the theme changes — lives in
 * electron/guest-scrollbar.js, which requires nothing; main.js only calls it.
 */
import { describe, expect, it } from "bun:test";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(import.meta.url);
const { scrollbarCss, createScrollbarBook } = require("../../electron/guest-scrollbar.js") as {
  scrollbarCss: (primary: unknown) => string | null;
  createScrollbarBook: () => {
    setPrimary: (primary: unknown) => boolean;
    apply: (guest: FakeGuest) => Promise<void>;
  };
};
const read = (rel: string) => Bun.file(resolve(import.meta.dir, rel)).text();
const MAIN = await read("../../electron/main.js");
const THEMES = await read("../../web/src/lib/themes.ts");
const GUEST_SRC = await read("../../electron/guest-scrollbar.js");
const PRELOAD = await read("../../electron/preload.js");
const dropComments = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

/** A guest that remembers what was inserted and what was taken off. */
class FakeGuest {
  sheets = new Map<string, string>();
  removed: string[] = [];
  destroyed = false;
  failRemove = false;
  private n = 0;
  isDestroyed() { return this.destroyed; }
  async insertCSS(css: string) { const k = `k${++this.n}`; this.sheets.set(k, css); return k; }
  async removeInsertedCSS(k: string) {
    if (this.failRemove) throw new Error("no such sheet");
    this.removed.push(k);
    this.sheets.delete(k);
  }
}

describe("scrollbarCss", () => {
  it("is the cockpit's bar: 7px, the theme's primary at 40% on the thumb, a transparent track", () => {
    const css = scrollbarCss("#7c5cff")!;
    expect(css).toContain("width: 7px");
    expect(css).toContain("height: 7px");
    expect(css).toContain("::-webkit-scrollbar-thumb { background: rgba(124, 92, 255, 0.4)");
    expect(css).toContain("::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent");
  });

  it("follows the theme: a light theme's primary gives a different thumb than a dark one's", () => {
    expect(scrollbarCss("#1d4ed8")).not.toBe(scrollbarCss("#a78bfa"));
    expect(scrollbarCss("#1d4ed8")).toContain("rgba(29, 78, 216, 0.4)");
  });

  it("yields to a page that styles its own bar: a cascade layer, nothing !important", () => {
    const css = scrollbarCss("#7c5cff")!;
    expect(css.startsWith("@layer agx-scrollbar {")).toBe(true);
    expect(css).not.toContain("!important");
  });

  it("takes a plain #rrggbb only; anything else is no stylesheet at all", () => {
    for (const bad of ["", "red", "#fff", "rgb(1,2,3)", "#7c5cffaa", "#7c5cff; } body { display:none", null, undefined, 42]) {
      expect(scrollbarCss(bad), String(bad)).toBeNull();
    }
  });
});

describe("createScrollbarBook", () => {
  it("puts nothing on a page before the renderer has said a colour", async () => {
    const g = new FakeGuest();
    await createScrollbarBook().apply(g);
    expect(g.sheets.size).toBe(0);
  });

  it("puts the stylesheet on a page that loads after the colour is known", async () => {
    const book = createScrollbarBook();
    book.setPrimary("#7c5cff");
    const g = new FakeGuest();
    await book.apply(g);
    expect([...g.sheets.values()]).toEqual([scrollbarCss("#7c5cff")!]);
  });

  it("swaps the sheet when the theme changes, leaving exactly one", async () => {
    const book = createScrollbarBook();
    book.setPrimary("#a78bfa");
    const g = new FakeGuest();
    await book.apply(g);
    expect(book.setPrimary("#1d4ed8")).toBe(true);
    await book.apply(g);
    expect(g.removed).toEqual(["k1"]);
    expect([...g.sheets.values()]).toEqual([scrollbarCss("#1d4ed8")!]);
  });

  it("says nothing changed when the same colour is reported again, or a bad one", () => {
    const book = createScrollbarBook();
    expect(book.setPrimary("#7c5cff")).toBe(true);
    expect(book.setPrimary("#7c5cff")).toBe(false);
    expect(book.setPrimary("not a colour")).toBe(false);
  });

  it("still inserts after a navigation, when the old sheet is already gone", async () => {
    const book = createScrollbarBook();
    book.setPrimary("#7c5cff");
    const g = new FakeGuest();
    await book.apply(g);
    g.failRemove = true;
    g.sheets.clear();
    await book.apply(g);
    expect(g.sheets.size).toBe(1);
  });

  it("leaves a destroyed page alone", async () => {
    const book = createScrollbarBook();
    book.setPrimary("#7c5cff");
    const g = new FakeGuest();
    g.destroyed = true;
    await book.apply(g);
    expect(g.sheets.size).toBe(0);
  });
});

describe("the wiring", () => {
  it("main.js applies it on every page load and to every open guest on a theme change", () => {
    const src = dropComments(MAIN);
    const load = src.slice(src.indexOf('guest.on("dom-ready"'));
    expect(load.slice(0, 200)).toContain("guestScrollbar.apply(guest)");
    const at = src.indexOf('ipcMain.on("ag:setGuestScrollbar"');
    expect(at).toBeGreaterThan(-1);
    const handler = src.slice(at, src.indexOf("\n  });", at));
    expect(handler).toContain("isLaneHost(e.sender)");
    expect(handler).toContain("for (const g of browserGuests) guestScrollbar.apply(g)");
  });

  it("the renderer reports its primary on every paint of a theme, through the preload", () => {
    expect(THEMES).toContain('setGuestScrollbar?.(vars["--primary"])');
    expect(PRELOAD).toContain('ipcRenderer.send("ag:setGuestScrollbar"');
  });

  it("no script is run in the page for it", () => {
    expect(dropComments(GUEST_SRC)).not.toContain("executeJavaScript");
  });
});
