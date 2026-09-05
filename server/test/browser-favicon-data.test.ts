/*
 * A tab's favicon, without asking the network from the window.
 *
 * `img-src` allows `'self' data: blob:`, loopback, and four named hosts. A
 * favicon from anywhere else — which is most of them — is blocked ALWAYS, not
 * only while the sidecar is booting. So the strip has been drawing its globe
 * fallback and the console has been paying for it: six violations on a launch
 * with his tabs open, and no icons to show for them.
 *
 * The shell fetches the bytes instead and hands back a `data:`, which the
 * policy already admits. Measured against the real app on a page whose icon
 * lives on a host the policy does not name:
 *
 *   before   2 CSP violations, no icon
 *   after    0 violations, and <img src="data:image/png;base64,iVBORw0KGgoA…">
 *            — the probe's own bytes, in the DOM
 *
 * WHY THIS IS NOT A PROXY, which is the whole reason it can exist. `prAsset`
 * refuses to become a general fetcher and guards itself with a host allowlist.
 * This has no allowlist of hosts at all; it has something narrower. It will
 * fetch a URL only if CHROMIUM reported that URL as the icon of a page THAT
 * GUEST had already loaded. There is no argument an agent can pass that
 * reaches the network — the set is filled by `page-favicon-updated` and read
 * by nothing else. Widening `img-src` was the other option and is worse: it
 * would admit every image on the internet to this window to save a fetch that
 * happens once per tab.
 *
 * These are source assertions because the alternative needs Electron, a guest,
 * and a page on a host the policy does not name. What they hold is the set of
 * properties that keep it from turning into the thing it was designed not to
 * be.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = join(import.meta.dir, "..", "..");
const main = readFileSync(join(REPO, "electron", "main.js"), "utf8");

/** The handler body, from its own `ipcMain.handle` to the next one. */
const handler = (() => {
  const start = main.indexOf('ipcMain.handle("ag:browserFavicon"');
  expect(start, "the handler is still called ag:browserFavicon").toBeGreaterThan(-1);
  const next = main.indexOf("ipcMain.handle(", start + 20);
  return main.slice(start, next === -1 ? main.length : next);
})();

/** Comments here name the very things the assertions are about. */
const bare = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the favicon bridge", () => {
  test("only fetches URLs the guest itself reported", () => {
    // The line between this and a general fetcher. Without it, any caller with
    // an id could name any URL and have the shell go and get it.
    expect(bare(handler)).toContain("guestFavicons.get(guest)");
    expect(bare(handler)).toContain("known.has(url)");
  });

  test("the set is filled by Chromium and by nothing else", () => {
    const b = bare(main);
    expect(b).toContain('guest.on("page-favicon-updated"');
    // One writer. A second one is a second way in, and the argument above stops
    // being true the moment there is one.
    const writes = [...b.matchAll(/guestFavicons\.set\(/g)];
    expect(writes.length, "one place fills the allowlist").toBe(1);
  });

  test("resolves the guest by id and refuses one it does not know", () => {
    // Three times in this file the same bug: read `browserGuest`, serve the tab
    // in front, answer ok. The capture, the DevTools relay, addInitScript.
    expect(bare(handler)).toContain("browserGuestById");
    expect(handler).toContain("that tab is not a browser pane in this window");
  });

  test("fetches on the guest's own session, not the shell's", () => {
    // Same cookies, partition and proxy as the page that named the icon — the
    // request it just made itself, not a privileged one.
    expect(bare(handler)).toContain("guest.session.fetch(");
  });

  test("images only, and small ones", () => {
    const b = bare(handler);
    // Without the type check this reads text off a host by calling it an icon.
    expect(b).toMatch(/\^image\\\//);
    expect(b).toContain("not an image");
    // A favicon is a few kB; the cap is what stops a large body being turned
    // into base64 in the renderer's memory.
    expect(b).toContain("too large for an icon");
  });

  test("and it never runs without a deadline", () => {
    // A host that accepts and never answers must not hold a handle for ever.
    expect(bare(handler)).toContain("AbortSignal.timeout(");
  });
});

describe("the strip that draws it", () => {
  const panel = readFileSync(join(REPO, "web", "src", "components", "BrowserPanel.tsx"), "utf8");

  test("resolves the icon once, when it arrives", () => {
    // Not at each of the three places that render one: that would need a guest
    // id threaded through them and would do the work again on every paint.
    expect(bare(panel)).toContain("bridge.browserFavicon(");
  });

  test("shows the URL first and replaces it after", () => {
    // Outside the desktop shell there is nothing to ask and the URL is all
    // there is; inside it, waiting for a round trip before drawing anything
    // would trade six console errors for a strip that flickers.
    expect(bare(panel)).toMatch(/patch\(id, \{ icon: url \}\);/);
  });

  test("and will not mark a tab that has moved on", () => {
    // The answer can arrive after a navigation. This panel has had that bug
    // twice; the icon is only replaced while the tab is still showing the one
    // this was fetched for.
    expect(bare(panel)).toContain("t.icon === url");
  });
});
