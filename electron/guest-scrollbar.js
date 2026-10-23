// The scrollbar a page in the built-in browser draws, in the app's colours.
//
// A page's own scrollbar is Chromium's stock one: light grey, 15px, and on a
// dark page next to a dark app it is the one thing on screen that looks like
// another program. The cockpit's own bar is 7px with a thumb that is the
// theme's primary at 40% (web/src/index.css, `::-webkit-scrollbar`); this makes
// every scrollable thing inside a page wear the same.
//
// Its own file, like guest-guard.js, so a test can require() it without main.js.
//
// The route is `webContents.insertCSS`: a stylesheet the browser adds to the
// document, in the page's own process but not in its world. No script runs in
// the page, no global is defined, and `document.styleSheets` does not list it,
// so a page cannot tell it is there except by measuring a scrollbar.
//
// Ceiling, named: the main frame only. A cross-origin iframe, the PDF viewer
// and devtools keep the stock bar, and a page that sets `scrollbar-width` or
// `scrollbar-color` itself opts out of every `::-webkit-scrollbar` rule, ours
// included. Both would need a CSS file per frame or a `color-scheme` override
// that also re-skins the page's form controls, which is a bigger step than this.
// Ours is the loser by design everywhere a page speaks for itself (see the layer
// below); a page that styles its bar badly keeps its bar.

const HEX = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;

/** The stylesheet for a theme whose primary is `primary`; null if that is not a plain #rrggbb.
 *  In a cascade layer and with no `!important`, so any rule the page wrote for
 *  its own scrollbar still wins: a carousel that hides its bar with `width: 0`
 *  stays hidden, and ours only fills in where the page left the stock one.
 *  @param {unknown} primary
 *  @returns {string | null} */
function scrollbarCss(primary) {
  const m = typeof primary === "string" ? HEX.exec(primary.trim()) : null;
  if (!m) return null;
  const thumb = `rgba(${parseInt(m[1], 16)}, ${parseInt(m[2], 16)}, ${parseInt(m[3], 16)}, 0.4)`;
  return [
    "@layer agx-scrollbar {",
    "  ::-webkit-scrollbar { width: 7px; height: 7px; background: transparent; }",
    `  ::-webkit-scrollbar-thumb { background: ${thumb}; border-radius: 6px; }`,
    "  ::-webkit-scrollbar-track, ::-webkit-scrollbar-corner { background: transparent; }",
    "}",
  ].join("\n");
}

/**
 * Which stylesheet each guest is wearing, and putting the current one on it.
 * @typedef {{ isDestroyed(): boolean, insertCSS(css: string): Promise<string>, removeInsertedCSS(key: string): Promise<void> }} Guest
 */
function createScrollbarBook() {
  /** @type {string | null} */
  let css = null;
  /** @type {WeakMap<object, string>} */
  const keys = new WeakMap();
  return {
    /** @param {unknown} primary @returns {boolean} whether the stylesheet changed */
    setPrimary(primary) {
      const next = scrollbarCss(primary);
      if (!next || next === css) return false;
      css = next;
      return true;
    },
    /** Put the current stylesheet on `guest`, taking off the one it wore. A
     *  navigation drops the old sheet by itself, so its key can be stale and
     *  removing it is allowed to fail.
     *  @param {Guest} guest */
    async apply(guest) {
      if (!css || guest.isDestroyed()) return;
      const old = keys.get(guest);
      if (old) await guest.removeInsertedCSS(old).catch(() => {});
      try { keys.set(guest, await guest.insertCSS(css)); } catch { /* a page on its way out */ }
    },
  };
}

module.exports = { scrollbarCss, createScrollbarBook };
