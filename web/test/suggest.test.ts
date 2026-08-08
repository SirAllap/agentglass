/*
 * What the address bar offers while you type.
 *
 * With fifteen thousand pages imported — the real number off this machine's
 * Zen — "does it contain what I typed" matches hundreds and is useless. The
 * feature is not the matching, it is that the FIRST row is the one you wanted.
 * So most of this is about order.
 */
import { describe, expect, it } from "bun:test";
import { score, suggest, typedHost, searchTerm, SUGGEST_MAX, SEARCH_MAX, type Place } from "../src/lib/suggest.ts";

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
    expect(rows[0]!.url).toBe("https://github.io/b");
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

  it("shows one page per host, not five of the same site", () => {
    const rows = suggest([
      p("https://github.com/a", { visits: 9 }),
      p("https://github.com/b", { visits: 8 }),
      p("https://github.com/c", { visits: 7 }),
      p("https://gitlab.com/x", { visits: 1 }),
      // The row that made this test read the HOST rather than the string. It
      // said `url.includes("github.com")`, and this URL contains that — in its
      // query, where a host name means nothing. A de-dup test that counts a
      // different site as the same site is measuring the wrong thing, and the
      // suite two blocks up already keeps a fixture of exactly this shape.
      p("https://elsewhere.test/?ref=github.com", { visits: 6 }),
    ], "git");
    expect(rows.filter((r) => hostOf(r.url) === "github.com")).toHaveLength(1);
    expect(rows.some((r) => hostOf(r.url) === "gitlab.com")).toBe(true);
  });

  it("lets a bookmark through even when its host is already there", () => {
    // It was kept on purpose, which is a stronger signal than a repeat visit.
    // The plain one is given enough visits to come first, so the bookmark is
    // the one the host-dedup would otherwise drop.
    const rows = suggest([
      p("https://github.com/a", { visits: 4000 }),
      p("https://github.com/keep", { bookmarked: true, title: "kept" }),
    ], "github");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.url).toBe("https://github.com/a");
    expect(rows[1]!.bookmarked).toBe(true);
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
