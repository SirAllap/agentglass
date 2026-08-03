// "Open this in the browser I already have."
//
// A one-slot request rather than a call, for the same reason the terminal's
// review request is one: the ports panel cannot reach the <webview>, and the
// browser view may not even be mounted when the button is pressed — it is one
// tab of a workspace that might be closed. The request is left here, the
// workspace opens on the browser, and the view picks it up when it has an
// element to navigate.
//
// Worth the indirection over just shelling out to the system browser: a dev
// server you started from this app, opened in a tab of this app, next to the
// terminal that is printing its log, is the whole reason the ports panel exists
// rather than being a nicer `ss`.

export type BrowserNav = { url: string; n: number };

let pending: BrowserNav | null = null;
const subs = new Set<() => void>();

export function subscribeBrowserNav(fn: () => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

export function browserNav(): BrowserNav | null { return pending; }

/** `n` increments so asking for the same address twice is two requests —
 *  otherwise navigating away and clicking the same port again would be
 *  indistinguishable from the request already served. */
export function requestBrowserNav(url: string): void {
  pending = { url, n: (pending?.n ?? 0) + 1 };
  subs.forEach((f) => f());
}

/** Cleared on send, not on arrival, so a request made while the view was still
 *  mounting is not silently dropped. */
export function clearBrowserNav(): void {
  pending = null;
  subs.forEach((f) => f());
}
