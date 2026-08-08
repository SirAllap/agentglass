// The browser's two settings. What matters here is the pair of states that are
// easy to conflate and behave differently: "never chose a home page" (use the
// default) and "chose a blank one" (open nothing). Clearing the key would make
// those indistinguishable, which is why blank is stored explicitly.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  BLANK, DEFAULT_HOME, ENGINE_KEY, HOME_KEY,
  homePage, homePageRaw, searchEngine, setHomePage, setSearchEngine,
  importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows,
} from "../src/lib/browserPrefs.ts";

// bun's test environment has no DOM; the module only ever touches these two.
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
};

beforeEach(() => store.clear());

describe("home page", () => {
  test("nothing chosen is the default, not a blank page", () => {
    expect(homePage()).toBe(DEFAULT_HOME);
    expect(homePageRaw()).toBe("");
  });

  test("a scheme-less domain is stored as the URL it will actually open", () => {
    expect(setHomePage("example.com")).toBe("https://example.com/");
    expect(homePage()).toBe("https://example.com/");
    // The field shows what was saved rather than what was typed, so the box
    // does not quietly disagree with where Home goes.
    expect(homePageRaw()).toBe("https://example.com/");
  });

  test("empty means blank, and blank survives a reload as a choice", () => {
    setHomePage("   ");
    expect(store.get(HOME_KEY)).toBe(BLANK);
    expect(homePage()).toBe(BLANK);
    // ...and comes back as an empty box, which is how it was offered.
    expect(homePageRaw()).toBe("");
  });

  test("something that is not an address is refused rather than saved", () => {
    setHomePage("https://good.example/");
    expect(setHomePage("javascript:alert(1)")).toBeNull();
    // The previous value is untouched — a rejected save must not also lose the
    // setting that was working.
    expect(homePage()).toBe("https://good.example/");
  });

  test("a hostile value already in storage is neutralised on the way out", () => {
    // Written by an older build, or by hand in devtools. The guest never sees it.
    store.set(HOME_KEY, "javascript:alert(1)");
    expect(homePage()).toBe(BLANK);
  });
});

describe("search engine", () => {
  test("google unless told otherwise", () => {
    expect(searchEngine()).toBe("google");
  });

  test("a choice round-trips", () => {
    setSearchEngine("duckduckgo");
    expect(searchEngine()).toBe("duckduckgo");
    expect(store.get(ENGINE_KEY)).toBe("duckduckgo");
  });

  test("junk in storage falls back rather than reaching the URL builder", () => {
    store.set(ENGINE_KEY, "askjeeves");
    expect(searchEngine()).toBe("google");
  });
});

describe("what rides along with a cookie import", () => {
  const H = (over: Partial<{ bookmarked: boolean }> = {}) => ({ url: "u", bookmarked: false, ...over });
  const B = () => ({ url: "u", bookmarked: true });

  test("both default ON, so leaving them alone changes nothing", () => {
    expect(importHistory()).toBe(true);
    expect(importBookmarks()).toBe(true);
  });

  test("only OFF is stored; turning back on clears the key, not stores 'true'", () => {
    setImportHistory(false);
    expect(store.get("agentglass.browser.importHistory")).toBe("0");
    expect(importHistory()).toBe(false);
    setImportHistory(true);
    expect(store.has("agentglass.browser.importHistory")).toBe(false);
    expect(importHistory()).toBe(true);
  });

  test("history off drops exactly the non-bookmarks, keeps the bookmarks", () => {
    const rows = [H(), H(), B()];
    expect(pickImportRows(rows, false, true)).toEqual([B()]);
  });

  test("bookmarks off drops exactly the bookmarks, keeps the history", () => {
    const rows = [H(), B(), H()];
    expect(pickImportRows(rows, true, false)).toEqual([H(), H()]);
  });

  test("both on keeps everything; both off keeps nothing", () => {
    const rows = [H(), B()];
    expect(pickImportRows(rows, true, true)).toHaveLength(2);
    expect(pickImportRows(rows, false, false)).toHaveLength(0);
  });
});
