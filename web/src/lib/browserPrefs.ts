// What the browser view remembers between sessions.
//
// Its own module because two places need it and neither should own it: the view
// reads these, the settings pane writes them, and a key spelled out in both is
// one typo from a setting that saves and never applies.
//
// Read on use rather than cached in state. The workspace's views are mounted
// once and never torn down, so anything read into a `useState` initialiser is
// read exactly once per app launch — a home page changed in settings would not
// take effect until a restart, which is the kind of bug that looks like the
// setting is broken.
import { normalizeNavigationUrl, DEFAULT_SEARCH_ENGINE, type SearchEngine } from "./browserUrl.ts";

export const HOME_KEY = "agentglass.browser.home";
export const ENGINE_KEY = "agentglass.browser.engine";

/** Not Google, and deliberately. This is a tool that opens pages on your behalf
 *  while you work; the default should be the one that does not build a profile
 *  out of it. Anybody who wants Google can say so in settings. */
export const DEFAULT_HOME = "https://duckduckgo.com";

/** A blank page is a real answer — "open nothing" is what an empty home means,
 *  the same as every other browser. */
export const BLANK = "about:blank";

function read(key: string): string {
  try { return localStorage.getItem(key) ?? ""; } catch { return ""; }
}

function write(key: string, value: string): void {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch { /* private mode, a full disk — losing a preference is not worth throwing over */ }
}

/**
 * The home page, as something safe to navigate to.
 *
 * Validated on the way out rather than only on the way in: the value could have
 * been written by an older build, hand-edited in devtools, or synced from
 * somewhere. Anything that is not http(s) becomes the blank page instead of
 * being handed to the guest.
 */
export function homePage(): string {
  const raw = read(HOME_KEY);
  // Nothing stored is "never chose", which is the default — not "chose blank".
  // Choosing blank stores `about:blank` explicitly, because clearing the key
  // would make the two indistinguishable and the choice unmakeable.
  if (!raw) return DEFAULT_HOME;
  if (raw === BLANK) return BLANK;
  return normalizeNavigationUrl(raw) ?? BLANK;
}

/** What the settings field shows. Blank comes back as an empty box, which is
 *  how it was chosen and how it is offered ("leave empty for a blank page"). */
export function homePageRaw(): string {
  const raw = read(HOME_KEY);
  return raw === BLANK ? "" : raw;
}

/** The stored value, or null when the input is not somewhere we would go — so
 *  the caller can say so rather than silently keeping the old one. */
export function setHomePage(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) { write(HOME_KEY, BLANK); return BLANK; }
  const url = normalizeNavigationUrl(trimmed);
  if (!url) return null;
  write(HOME_KEY, url);
  return url;
}

export function searchEngine(): SearchEngine {
  const v = read(ENGINE_KEY);
  return v === "duckduckgo" || v === "bing" || v === "google" ? v : DEFAULT_SEARCH_ENGINE;
}

export function setSearchEngine(engine: SearchEngine): void {
  write(ENGINE_KEY, engine);
}
