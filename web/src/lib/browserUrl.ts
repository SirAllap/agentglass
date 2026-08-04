// What the address bar does with what you typed.
//
// One function serves two callers with opposite needs, and the difference is a
// single argument. The address bar wants `react hooks` to become a search. A
// validator — anything deciding whether a navigation is allowed at all — must
// reject it instead, because turning unrecognised text into a Google URL is a
// fine autocomplete and a terrible security boundary. So the search fallback is
// opt-in: pass a search engine and you get one, omit it and you get null.
//
// (The main process has its own, much smaller guard in electron/main.js. It is
// deliberately not this file: main.js is plain CommonJS with no build step and
// cannot import TypeScript, and a security check you can read in five lines
// beats one that shares three hundred with an autocomplete.)

export type SearchEngine = "google" | "duckduckgo" | "bing";

export const SEARCH_ENGINE_LABELS: Record<SearchEngine, string> = {
  google: "Google",
  duckduckgo: "DuckDuckGo",
  bing: "Bing",
};

const SEARCH_URLS: Record<SearchEngine, string> = {
  google: "https://www.google.com/search?q=",
  duckduckgo: "https://duckduckgo.com/?q=",
  bing: "https://www.bing.com/search?q=",
};

export const DEFAULT_SEARCH_ENGINE: SearchEngine = "google";

/** `localhost:5173`, `127.0.0.1:8080/path`, `[::1]:3000` — a dev server, which
 *  is most of what anyone types into a browser inside a coding tool. These get
 *  http, not https: a local dev server usually has no certificate, and guessing
 *  https means the first thing the pane ever does is fail. */
const LOCAL_ADDRESS = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[[0-9a-f:]+\])(?::\d+)?(?:[/?#].*)?$/i;

/** `example.com`, `foo.bar/path` — a bare word with a dot and a TLD-shaped tail
 *  is a domain someone did not bother to type the scheme for. */
const LOOKS_LIKE_DOMAIN = /^[^\s]+\.[a-z]{2,}(?:[/?#].*)?$/i;

export function buildSearchUrl(query: string, engine: SearchEngine = DEFAULT_SEARCH_ENGINE): string {
  return `${SEARCH_URLS[engine] ?? SEARCH_URLS[DEFAULT_SEARCH_ENGINE]}${encodeURIComponent(query)}`;
}

/**
 * Words, or an address?
 *
 * A space settles it: no hostname has one. Otherwise a dot or a colon means
 * somebody is naming a host or a port, and everything else is a search.
 */
export function looksLikeSearchQuery(input: string): boolean {
  const s = input.trim();
  if (!s) return true;
  if (/\s/.test(s)) return true;
  if (LOOKS_LIKE_DOMAIN.test(s)) return false;
  return !(s.includes(".") || s.includes(":"));
}

/**
 * What to navigate to, or null for "this is not somewhere I will go".
 *
 * Only http and https come back. `file:` is refused even though the guest could
 * technically render it: this pane exists to look at web pages, and a browser
 * inside a developer tool that will follow `file:///` is one hostile page away
 * from being a file reader.
 *
 * @param searchEngine omit to validate, pass to let unrecognised text become a
 *   search. That is the whole difference between the two callers.
 */
export function normalizeNavigationUrl(raw: string, searchEngine?: SearchEngine): string | null {
  const s = (raw || "").trim();
  if (!s) return null;

  // Before the URL parser, because `new URL("localhost:5173")` parses cleanly
  // as protocol `localhost:` and would otherwise be rejected as a scheme we do
  // not allow — the single most likely thing to be typed here.
  if (LOCAL_ADDRESS.test(s)) {
    try { return new URL(`http://${s}`).toString(); } catch { /* fall through */ }
  }

  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch { /* not absolute — decided below */ }

  // No scheme. A domain gets https; anything else is either a search or, for a
  // validator, nothing at all.
  if (!looksLikeSearchQuery(s)) {
    try { return new URL(`https://${s}`).toString(); } catch { /* not a host either */ }
  }
  return searchEngine ? buildSearchUrl(s, searchEngine) : null;
}

/** The address as a person reads it: no scheme, no trailing slash on a bare
 *  host. Shown when the bar is not focused, so the URL is legible rather than
 *  ceremonial. */
export function displayUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const tail = u.pathname === "/" && !u.search && !u.hash ? "" : `${u.pathname}${u.search}${u.hash}`;
    return `${u.host}${tail}`;
  } catch {
    return raw;
  }
}
