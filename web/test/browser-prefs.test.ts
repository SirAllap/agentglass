// The browser's two settings. What matters here is the pair of states that are
// easy to conflate and behave differently: "never chose a home page" (use the
// default) and "chose a blank one" (open nothing). Clearing the key would make
// those indistinguishable, which is why blank is stored explicitly.
import { beforeEach, describe, expect, test } from "bun:test";
import {
  BLANK, DEFAULT_HOME, ENGINE_KEY, HOME_KEY,
  homePage, homePageRaw, searchEngine, setHomePage, setSearchEngine,
  importHistory, setImportHistory, importBookmarks, setImportBookmarks, pickImportRows,
  zoomPercent, stepZoom, ZOOM_PCT_MIN, ZOOM_PCT_MAX,
} from "../src/lib/browserPrefs.ts";
import { readFileSync } from "node:fs";

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

/*
 * ZOOM MOVES IN TENS.
 *
 * Chromium's own ladder is geometric — every step multiplies by 1.2^0.5 — so it
 * walks 100, 110, 120, 132, 145, 158, 173. Each step is the same proportion and
 * no two are the same NUMBER, which is what makes it read as arbitrary from
 * outside: "sometimes it goes up by five, sometimes by three. That has to be
 * something consistent."
 */
describe("the zoom ladder", () => {
  const pct = (l: number) => zoomPercent(l);
  const walk = (from: number, dir: 1 | -1, n: number) => {
    const out: number[] = []; let l = from;
    for (let i = 0; i < n; i++) { l = stepZoom(l, dir); out.push(pct(l)); }
    return out;
  };

  test("goes up in tens", () => {
    expect(walk(0, 1, 8)).toEqual([110, 120, 130, 140, 150, 160, 170, 180]);
  });

  test("and down in tens", () => {
    expect(walk(0, -1, 7)).toEqual([90, 80, 70, 60, 50, 40, 30]);
  });

  test("snaps an off-grid level onto the ten with the FIRST press", () => {
    /* A level can arrive from anywhere — an old stored value from the geometric
       ladder, a pinch, a session that predates this. Carrying its offset
       forever would mean 107 → 117 → 127, which is the same complaint one step
       removed. */
    const at107 = Math.log(1.07) / Math.log(1.2);
    expect(pct(stepZoom(at107, 1))).toBe(110);
    expect(pct(stepZoom(at107, -1))).toBe(100);
    const at158 = Math.log(1.58) / Math.log(1.2);
    expect(pct(stepZoom(at158, 1))).toBe(160);
    expect(pct(stepZoom(at158, -1))).toBe(150);
  });

  test("stops at the ends instead of walking off them", () => {
    let l = 0;
    for (let i = 0; i < 40; i++) l = stepZoom(l, -1);
    expect(pct(l)).toBe(ZOOM_PCT_MIN);
    l = 0;
    for (let i = 0; i < 60; i++) l = stepZoom(l, 1);
    expect(pct(l)).toBe(ZOOM_PCT_MAX);
  });

  test("the shell walks the same ladder — two copies that must not drift", () => {
    /* The main process cannot import this module, so the arithmetic is
       mirrored there. Both are a handful of lines; what must not happen is one
       of them changing alone. */
    const main = readFileSync(new URL("../../electron/main.js", import.meta.url), "utf8");
    expect(main, "the shell still steps by a constant proportion").not.toContain("ZOOM_STEP");
    expect(main).toContain("ZOOM_PCT_STEP = 10");
    expect(main).toContain("stepZoom(");
  });
});
