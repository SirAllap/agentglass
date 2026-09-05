// What the right button offers on a page in the built-in browser.
//
// Its own file for the same two reasons as guest-guard.js: main.js is the
// Electron entry point and cannot be imported by a test, and this is the part
// worth testing — not "does a menu appear", which needs a pointer and a screen,
// but WHICH items a given click produces. A right click on a link and a right
// click on empty page are different menus, and getting that wrong is how a
// browser ends up offering "copy link address" for a paragraph.
//
// It builds a plain template — labels, roles, separators and closures over the
// handlers it is given. Electron's Menu is never touched here, so a test can
// call it with a fake `params` and press the items.
//
// CommonJS with no build step, like main.js, and listed in `build.files` in
// package.json: left out of the asar, the app does not start.

/**
 * The menu for one right click.
 *
 * `params` is Chromium's own `context-menu` payload, trusted for its shape and
 * not for its contents: every url in it goes through `safeUrl` before it is
 * offered, because "open link in a new tab" on a `javascript:` or `file:` link
 * is exactly the sort of thing a hostile page would like this menu to do.
 *
 * Only what the app can actually carry out. There is no "save link as" while
 * there is nowhere for a download to land and no "bookmark" while there are no
 * bookmarks — a menu item that does nothing is worse than a shorter menu.
 */
function browserMenuTemplate(params, ctx) {
  const p = params || {};
  const safe = ctx.safeUrl || ((u) => u);
  const on = ctx.on || {};
  const items = [];

  const link = p.linkURL ? safe(p.linkURL) : null;
  if (link) {
    items.push(
      { label: "Open link in a new tab", click: () => on.openTab(link) },
      { label: "Copy link address", click: () => on.copyText(p.linkURL) },
      // Named as leaving, because the page is signed in HERE and the browser it
      // lands in may be signed in as somebody else entirely.
      { label: "Open link in your own browser", click: () => on.openExternal(link) },
      { type: "separator" },
    );
  }

  const img = p.mediaType === "image" && p.srcURL ? safe(p.srcURL) : null;
  if (img) {
    items.push(
      { label: "Open image in a new tab", click: () => on.openTab(img) },
      { label: "Copy image", click: () => on.copyImage() },
      { label: "Copy image address", click: () => on.copyText(p.srcURL) },
      { type: "separator" },
    );
  }

  // An editable box gets the editing menu and NOT the selection one: "search
  // the web for" over a half-typed comment is the wrong offer, and the roles
  // below are the platform's own cut/copy/paste, which behave correctly with
  // an IME and a selection that spans elements.
  if (p.isEditable) {
    items.push({ role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }, { type: "separator" });
  } else if ((p.selectionText || "").trim()) {
    const text = p.selectionText.trim();
    // Elided in the LABEL only. A menu item as wide as the paragraph you
    // selected pushes the menu off the screen; the search still gets the text.
    const shown = text.length > 32 ? `${text.slice(0, 32)}…` : text;
    items.push(
      { role: "copy" },
      { label: `Search the web for “${shown}”`, click: () => on.search(text.slice(0, 400)) },
      { type: "separator" },
    );
  }

  const here = ctx.pageUrl ? safe(ctx.pageUrl) : null;
  items.push(
    // Disabled rather than absent: where back and forward are is something you
    // learn once, and a menu whose items move depending on history is a menu
    // you have to read every time.
    { label: "Back", enabled: !!ctx.canBack, click: () => on.back() },
    { label: "Forward", enabled: !!ctx.canForward, click: () => on.forward() },
    { label: "Reload", click: () => on.reload() },
    { type: "separator" },
    { label: "Copy this page's address", enabled: !!here, click: () => on.copyText(ctx.pageUrl) },
    { label: "Open this page in your own browser", enabled: !!here, click: () => on.openExternal(here) },
    { type: "separator" },
    { label: "Inspect", click: () => on.inspect() },
  );
  return items;
}

module.exports = { browserMenuTemplate };
