/*
 * What the address bar offers while you type.
 *
 * With fifteen thousand pages imported — the real number off this machine's
 * Zen — "does it contain what I typed" matches hundreds and is useless. The
 * feature is not the matching, it is that the FIRST row is the one you wanted.
 * So most of this is about order.
 */
import { describe, expect, it } from "bun:test";
import { score, suggest, typedHost, searchTerm, completion, litRow, isJunk, frecency, tabKey, switchable, listedAsTab, tabRowKey, type OpenTab, SUGGEST_MAX, SEARCH_MAX, SITE_PAGES, type Place } from "../src/lib/suggest.ts";

const p = (url: string, over: Partial<Place> = {}): Place =>
  ({ url, title: "", visits: 1, lastAt: 0, bookmarked: false, ...over });

/** Which site a row is FROM. `url.includes("github.com")` is also true of
 *  `https://elsewhere.test/?ref=github.com`, and the one thing the host-dedup
 *  test has to get right is which rows are the same site. */
const hostOf = (url: string): string => new URL(url).hostname;

describe("the part of a URL you type at", () => {
  it("drops the scheme, the www and the trailing slash", () => {
    expect(typedHost("https://www.github.com/")).toBe("github.com");
    expect(typedHost("http://localhost:8001/app")).toBe("localhost:8001/app");
  });
});

describe("where the match landed", () => {
  it("puts a host that starts with what you typed first", () => {
    const rows = suggest([
      p("https://example.com/?q=github", { visits: 500 }),
      p("https://github.com/", { visits: 2 }),
    ], "github");
    expect(rows[0]!.url).toBe("https://github.com/");
    expect(rows[0]!.why).toBe("host");
  });

  it("does not let a much-visited page beat an exact host match", () => {
    // The real shape of this machine's history: one host visited 431 times.
    const rows = suggest([
      p("https://busy.test/a", { visits: 431, title: "clickup dashboard" }),
      p("https://clickup.com/", { visits: 3 }),
    ], "clickup");
    expect(rows[0]!.url).toBe("https://clickup.com/");
  });

  it("uses visits to break a tie, not to decide one", () => {
    const rows = suggest([
      p("https://github.com/a", { visits: 2 }),
      p("https://github.io/b", { visits: 90 }),
    ], "github");
    // Row one is the site's bare origin, picked by how much you use the site.
    expect(rows[0]!.url).toBe("https://github.io/");
  });

  it("ranks a bookmark above an ordinary page it ties with", () => {
    const rows = suggest([
      p("https://docs.test/", { visits: 5 }),
      p("https://docs.example/", { visits: 5, bookmarked: true }),
    ], "docs");
    expect(rows[0]!.bookmarked).toBe(true);
  });

  it("finds a bookmark by its title, which is the name you gave it", () => {
    const rows = suggest([p("https://x.invalid/9f2", { bookmarked: true, title: "Quarterly plan" })], "quarterly");
    expect(rows[0]!.why).toBe("bookmark");
  });

  it("offers nothing for a miss rather than a bad guess", () => {
    expect(suggest([p("https://github.com/")], "zzzz")).toEqual([]);
    expect(score(p("https://github.com/"), "zzzz").score).toBe(0);
  });

  it("says nothing at all before a character is typed", () => {
    expect(suggest([p("https://github.com/")], "")).toEqual([]);
    expect(suggest([p("https://github.com/")], "   ")).toEqual([]);
  });
});

describe("how many, and of what", () => {
  it("stops at eight", () => {
    const many = Array.from({ length: 40 }, (_, i) => p(`https://site${i}.test/`));
    expect(suggest(many, "site")).toHaveLength(SUGGEST_MAX);
  });

  it("shows a few pages of the leading site, then one row per other host", () => {
    const rows = suggest([
      p("https://acme.test/a", { visits: 9 }),
      p("https://acme.test/b", { visits: 8 }),
      p("https://acme.test/c", { visits: 7 }),
      p("https://acme.test/d", { visits: 6 }),
      p("https://acme.test/e", { visits: 5 }),
      p("https://acmelabs.test/x", { visits: 4 }),
      p("https://acmelabs.test/y", { visits: 3 }),
      // The host-vs-string trap: this URL CONTAINS "acme" in its query only.
      p("https://elsewhere.test/?ref=acme.test", { visits: 6 }),
    ], "acm");
    expect(rows.filter((r) => hostOf(r.url) === "acme.test")).toHaveLength(1 + SITE_PAGES);
    expect(rows.filter((r) => hostOf(r.url) === "acmelabs.test")).toHaveLength(1);
  });

  it("lets a bookmark through even when its host is already there", () => {
    // Kept on purpose: stronger than a repeat visit, so it is shown even when
    // the site's own pages are already above it.
    const pages = [1, 2, 3, 4].map((n) => p(`https://orbit.test/p${n}`, { visits: 4000 - n }));
    const rows = suggest([...pages, p("https://orbit.test/keep", { bookmarked: true, title: "kept" })], "orbit");
    expect(rows.some((r) => r.url === "https://orbit.test/keep")).toBe(true);
  });

  it("is case-insensitive and ignores what you typed around it", () => {
    expect(suggest([p("https://GitHub.com/")], "  GITHUB ")).toHaveLength(1);
  });

  it("prefers the shorter URL when everything else ties", () => {
    const rows = suggest([
      p("https://a.test/deep/path/here"),
      p("https://a.test/"),
    ], "a.test");
    expect(rows[0]!.url).toBe("https://a.test/");
  });
});

describe("the searches you already ran", () => {
  it("pulls the term out of a results URL, and only of a real search page", () => {
    expect(searchTerm("https://www.google.com/search?q=react+hooks")).toBe("react hooks");
    expect(searchTerm("https://duckduckgo.com/?q=typescript%20generics")).toBe("typescript generics");
    // Google carries ?q= on maps and images; those are places, not searches.
    expect(searchTerm("https://www.google.com/maps?q=coffee")).toBeNull();
    // An ordinary page with a q= param is not a search engine.
    expect(searchTerm("https://example.com/?q=react")).toBeNull();
    // Nothing to offer back.
    expect(searchTerm("https://www.google.com/search?q=")).toBeNull();
    expect(searchTerm("not a url")).toBeNull();
  });

  it("shows several past searches on one engine, not a single collapsed row", () => {
    // The actual bug: every google search shares one host, so the per-host
    // de-dup used to leave only the first. Term de-dup lets each one through.
    const rows = suggest([
      p("https://www.google.com/search?q=react+hooks", { title: "react hooks - Google Search" }),
      p("https://www.google.com/search?q=react+router", { title: "react router - Google Search" }),
      p("https://www.google.com/search?q=react+context", { title: "react context - Google Search" }),
    ], "react");
    const searches = rows.filter((r) => r.why === "search");
    expect(searches).toHaveLength(3);
    expect(new Set(searches.map((s) => s.query)).size).toBe(3);
    expect(searches.every((s) => s.query!.startsWith("react"))).toBe(true);
  });

  it("offers the term back as the query, not the long results URL", () => {
    const rows = suggest([p("https://www.google.com/search?q=tailwind+grid")], "tailwind");
    expect(rows[0]!.why).toBe("search");
    expect(rows[0]!.query).toBe("tailwind grid");
  });

  it("still gives you the engine itself when you type its name", () => {
    // Typing "google" means google.com, never a hundred of your old searches.
    const rows = suggest([
      p("https://www.google.com/", { visits: 50 }),
      p("https://www.google.com/search?q=google+fonts", { title: "google fonts - Google Search" }),
    ], "google");
    expect(rows[0]!.url).toBe("https://www.google.com/");
    expect(rows[0]!.why).toBe("host");
  });

  it("collapses the same term run twice into one row", () => {
    const rows = suggest([
      p("https://www.google.com/search?q=vite+config&hl=en"),
      p("https://www.google.com/search?q=vite+config&hl=es"),
    ], "vite");
    expect(rows.filter((r) => r.why === "search")).toHaveLength(1);
  });

  it("caps how many searches crowd the list", () => {
    const many = Array.from({ length: 12 }, (_, i) => p(`https://www.google.com/search?q=query+number+${i}`));
    const rows = suggest(many, "query");
    expect(rows.filter((r) => r.why === "search").length).toBeLessThanOrEqual(SEARCH_MAX);
  });
});

describe("a normal browser's first rows", () => {
  const now = Date.now() / 1000;
  const day = 86400;

  it("puts the bare origin first when you type a host prefix", () => {
    const rows = suggest([
      p("https://orbit.test/team/repo/pull/7", { visits: 30, lastAt: now, title: "Fix thing" }),
      p("https://orbit.test/team/repo", { visits: 20, lastAt: now, title: "team/repo" }),
      p("https://status.orbit.test/", { visits: 3, lastAt: now }),
    ], "orb");
    expect(rows[0]!.url).toBe("https://orbit.test/");
    expect(rows[0]!.title).toBe("Orbit");
    // Then that site's most-visited pages, most visited first.
    expect(rows[1]!.url).toBe("https://orbit.test/team/repo/pull/7");
    expect(rows[2]!.url).toBe("https://orbit.test/team/repo");
  });

  it("uses the real root page's title for the origin row", () => {
    const rows = suggest([p("https://orbit.test/", { title: "Orbit Home", visits: 5 })], "orb");
    expect(rows[0]!.title).toBe("Orbit Home");
  });

  it("lets a much-used old site beat a single recent visit", () => {
    const old = p("https://acme.test/", { visits: 40, lastAt: now - 60 * day });
    const fresh = p("https://acmelabs.test/", { visits: 1, lastAt: now });
    expect(frecency(old, now)).toBeGreaterThan(frecency(fresh, now));
    expect(suggest([fresh, old], "acm")[0]!.url).toBe("https://acme.test/");
  });

  it("keeps asset and blob URLs out of the top rows", () => {
    const junk = [
      p("https://orbit-user-assets.s3.amazonaws.com/9f2c1d3e4b5a69788796a5b4c3d2e1f0/shot.png", { visits: 99, lastAt: now }),
      p("https://orbit.usercontent.example.com/raw/abc", { visits: 99, lastAt: now }),
      p("https://orbit.test/releases/orbit-1.2.zip", { visits: 99, lastAt: now }),
      p("https://orbit.test/downloads/0123456789abcdef0123456789abcdef", { visits: 99, lastAt: now }),
    ];
    expect(junk.every((j) => isJunk(j.url))).toBe(true);
    const rows = suggest([...junk, p("https://orbit.test/docs", { visits: 1, lastAt: now })], "orb");
    expect(rows.map((r) => r.url)).not.toContain(junk[0]!.url);
    expect(rows.every((r) => !isJunk(r.url))).toBe(true);
    expect(isJunk("https://orbit.test/docs")).toBe(false);
  });

  it("drops a repeated URL and a repeated title on one host", () => {
    const rows = suggest([
      p("https://orbit.test/a", { title: "Docs", visits: 9 }),
      p("https://orbit.test/a#intro", { title: "Docs intro", visits: 8 }),
      p("https://orbit.test/b", { title: "Docs", visits: 7 }),
    ], "orb");
    expect(rows.filter((r) => r.url.startsWith("https://orbit.test/a"))).toHaveLength(1);
    expect(rows.filter((r) => r.title === "Docs")).toHaveLength(1);
  });

  it("completes a host prefix inline, and never a search", () => {
    const places = [p("https://github.com/", { visits: 9 }), p("https://gitlab.com/", { visits: 2 })];
    expect(completion(places, "git")).toBe("hub.com/");
    expect(completion(places, "git hub")).toBeNull();
    expect(completion(places, "github.com/x")).toBeNull();
    expect(completion(places, "zzz")).toBeNull();
    expect(completion(places, "")).toBeNull();
  });

  it("an exact host beats a busier host that merely starts with it", () => {
    const places = [p("https://github.com/", { visits: 1 }), p("https://github.community/", { visits: 90 })];
    expect(completion(places, "github.com")).toBeNull();
    expect(suggest(places, "github.com")[0]!.url).toBe("https://github.com/");
  });

  it("junk hashes are hex or long mixed runs; plain slugs are pages", () => {
    expect(isJunk("https://orbit.test/blog/how-to-configure-the-widget-framework-properly")).toBe(false);
    expect(isJunk("https://orbit.test/top-10-things-to-do-in-2024-for-the-whole-family")).toBe(false);
    expect(isJunk("https://orbit.test/files/0123456789abcdef01234567")).toBe(true);
    expect(isJunk("https://orbit.test/dl/a1B2c3D4e5F6a1B2c3D4e5F6a1B2c3D4e5")).toBe(true);
    expect(isJunk("https://cdn.orbit.test/f/0123456789abcdef01234567")).toBe(true);
  });

  it("a hash on a normal site is a page, not junk", () => {
    expect(isJunk("https://github.com/acme/orbit/commit/0123456789abcdef0123456789abcdef01234567")).toBe(false);
    const places = [p("https://github.com/acme/orbit/commit/0123456789abcdef0123456789abcdef01234567", { visits: 3 })];
    expect(suggest(places, "github")[0]!.url).toContain("github.com");
  });

  it("a blob permalink or commit page on a normal host is suggested; an s3 asset is not", () => {
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const blob = `https://github.example/acme/orbit/blob/${sha}/src/a.ts`;
    const raw = `https://github.example/acme/orbit/raw/${sha}/src/a.ts`;
    const commit = `https://github.example/acme/orbit/commit/${sha}`;
    const s3 = `https://orbit-bucket.s3.amazonaws.com/blob/${sha}/thing`;
    const zip = "https://orbit.test/dl/build.tar.gz";
    expect(isJunk(blob)).toBe(false);
    expect(isJunk(raw)).toBe(false);
    expect(isJunk(commit)).toBe(false);
    expect(isJunk(s3)).toBe(true);
    expect(isJunk(zip)).toBe(true);
    const rows = suggest([p(blob, { visits: 3 }), p(commit, { visits: 3 }), p(s3, { visits: 3 })], "github");
    expect(rows.map((r) => r.url)).toEqual(expect.arrayContaining([blob, commit]));
    expect(rows.map((r) => r.url)).not.toContain(s3);
  });

  it("Enter takes the typed text unless the user moved or a completion is lit", () => {
    expect(litRow(-1, false)).toBe(-1);
    expect(litRow(-1, true)).toBe(0);
    expect(litRow(2, false)).toBe(2);
    expect(litRow(2, true)).toBe(2);
  });

  it("completes only from the stored host, www. included", () => {
    const bare = [p("https://github.com/", { visits: 9 })];
    expect(completion(bare, "www.git")).toBeNull();
    const www = [p("https://www.github.com/", { visits: 9 })];
    expect(completion(www, "www.git")).toBe("hub.com/");
  });
});

describe("switch to an open tab", () => {
  const tab = (id: string, url: string, over: Partial<OpenTab> = {}): OpenTab => ({ id, url, title: "", ...over });
  const hist = [p("https://docs.example.com/guide", { title: "Guide", visits: 2 })];

  it("matches ignoring trailing slash and hash", () => {
    expect(tabKey("https://a.test/x/#top")).toBe(tabKey("https://a.test/x"));
    expect(tabKey("https://a.test/x")).not.toBe(tabKey("https://a.test/y"));
    expect(tabKey("https://app.test/#/inbox")).not.toBe(tabKey("https://app.test/#/settings"));
    expect(tabKey("https://app.test/#!/a")).not.toBe(tabKey("https://app.test/#!/b"));
    expect(tabKey("https://app.test/#/inbox")).not.toBe(tabKey("https://app.test/"));
    expect(tabKey("about:blank")).toBeNull();
  });
  it("keeps the query, and the case of the path", () => {
    expect(tabKey("https://a.test/s?q=a")).not.toBe(tabKey("https://a.test/s?q=b"));
    expect(tabKey("https://a.test/s?q=a#x")).toBe(tabKey("https://a.test/s?q=a"));
    expect(tabKey("https://A.TEST/Docs")).toBe(tabKey("https://a.test/Docs"));
    expect(tabKey("https://a.test/Docs")).not.toBe(tabKey("https://a.test/docs"));
  });
  it("never lists one tab twice (open row and Switch to tab row)", () => {
    const s = suggest([], "wiki", 8, [tab("t3", "https://wiki.example.org/home")]).find((r) => r.tabId === "t3")!;
    expect(listedAsTab([{ key: tabRowKey("t3") }], s)).toBe(true);
    expect(listedAsTab([{ key: tabRowKey("t9") }], s)).toBe(false);
  });
  it("tags a history row whose page is open in another tab", () => {
    const rows = suggest(hist, "guide", 8, [tab("t2", "https://docs.example.com/guide/#intro")]);
    expect(rows.filter((r) => r.tabId === "t2").length).toBe(1);
    expect(rows.filter((r) => tabKey(r.url) === tabKey("https://docs.example.com/guide")).length).toBe(1);
  });
  it("offers an open tab even with no history for it", () => {
    const rows = suggest([], "wiki", 8, [tab("t3", "https://wiki.example.org/home")]);
    expect(rows.some((r) => r.tabId === "t3")).toBe(true);
  });
  it("never offers the current tab, nor an agent's tab", () => {
    const tabs = [tab("cur", "https://a.test/"), tab("ag", "https://b.test/", { agent: "scout" }), tab("me", "https://c.test/")];
    expect(switchable(tabs, "cur").map((t) => t.id)).toEqual(["me"]);
    expect(suggest([], "a.test", 8, switchable(tabs, "cur")).some((r) => r.tabId)).toBe(false);
  });
  it("lists one tab per page", () => {
    const tabs = [tab("a", "https://a.test/x"), tab("b", "https://a.test/x/#h")];
    expect(switchable(tabs, "z").map((t) => t.id)).toEqual(["a"]);
  });
});
