// The address bar decides between "go here" and "search for this", and the same
// function is the validator for whether a navigation is allowed at all. The
// invariants that matter: the search fallback is opt-in, so a validator never
// turns junk into a Google URL; only http(s) ever comes back; and a bare
// `localhost:5173` — the most likely thing anyone types into a browser that
// lives inside a coding tool — goes to the dev server rather than to a search.
import { describe, expect, test } from "bun:test";
import {
  buildSearchUrl, displayUrl, looksLikeSearchQuery, normalizeNavigationUrl,
} from "../src/lib/browserUrl.ts";

describe("looksLikeSearchQuery", () => {
  test("a space settles it — no hostname has one", () => {
    expect(looksLikeSearchQuery("react hooks")).toBe(true);
    expect(looksLikeSearchQuery("how do i rebase")).toBe(true);
  });

  test("a domain-shaped word is an address", () => {
    expect(looksLikeSearchQuery("example.com")).toBe(false);
    expect(looksLikeSearchQuery("foo.bar/path")).toBe(false);
    expect(looksLikeSearchQuery("localhost:5173")).toBe(false);
  });

  test("a bare word is words", () => {
    expect(looksLikeSearchQuery("electron")).toBe(true);
    expect(looksLikeSearchQuery("")).toBe(true);
  });
});

describe("normalizeNavigationUrl as a validator (no search engine)", () => {
  test("http(s) passes through", () => {
    expect(normalizeNavigationUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
    expect(normalizeNavigationUrl("http://example.com/")).toBe("http://example.com/");
  });

  test("a scheme-less domain is assumed https", () => {
    expect(normalizeNavigationUrl("example.com")).toBe("https://example.com/");
  });

  test("words are rejected rather than searched — this is the security bit", () => {
    // A validator that helpfully converted this into a search URL would answer
    // "yes, navigate" to literally any input.
    expect(normalizeNavigationUrl("react hooks")).toBeNull();
    expect(normalizeNavigationUrl("electron")).toBeNull();
  });

  test("no scheme but http(s) is ever allowed through", () => {
    expect(normalizeNavigationUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeNavigationUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
    // Refused on purpose: a browser inside a developer tool that follows
    // file:/// is one hostile page away from being a file reader.
    expect(normalizeNavigationUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeNavigationUrl("agentglass://app/")).toBeNull();
  });

  test("empty is nowhere", () => {
    expect(normalizeNavigationUrl("")).toBeNull();
    expect(normalizeNavigationUrl("   ")).toBeNull();
  });
});

describe("normalizeNavigationUrl as an address bar (search engine given)", () => {
  test("words become a search", () => {
    expect(normalizeNavigationUrl("react hooks", "google"))
      .toBe("https://www.google.com/search?q=react%20hooks");
    expect(normalizeNavigationUrl("electron", "duckduckgo"))
      .toBe("https://duckduckgo.com/?q=electron");
  });

  test("an address is still an address", () => {
    expect(normalizeNavigationUrl("example.com", "google")).toBe("https://example.com/");
    expect(normalizeNavigationUrl("https://example.com/x", "google")).toBe("https://example.com/x");
  });

  test("a hostile scheme is not rescued into a search either", () => {
    // It is not a URL we will go to, and it is not words: turning it into a
    // search would be a surprise, and following it would be a hole.
    expect(normalizeNavigationUrl("javascript:alert(1)", "google")).toBeNull();
  });
});

describe("local dev addresses", () => {
  test("localhost with a port goes to http, not to a search", () => {
    expect(normalizeNavigationUrl("localhost:5173")).toBe("http://localhost:5173/");
    expect(normalizeNavigationUrl("localhost:5173", "google")).toBe("http://localhost:5173/");
  });

  test("loopback and a path survive", () => {
    expect(normalizeNavigationUrl("127.0.0.1:8080/health")).toBe("http://127.0.0.1:8080/health");
  });

  test("http rather than https, because a dev server rarely has a certificate", () => {
    expect(normalizeNavigationUrl("localhost")).toBe("http://localhost/");
  });
});

describe("buildSearchUrl", () => {
  test("the query is encoded", () => {
    expect(buildSearchUrl("a b&c", "bing")).toBe("https://www.bing.com/search?q=a%20b%26c");
  });

  test("an unknown engine falls back rather than producing undefined", () => {
    expect(buildSearchUrl("x", "nope" as never)).toContain("google.com");
  });
});

describe("displayUrl", () => {
  test("the scheme and a bare trailing slash come off", () => {
    expect(displayUrl("https://example.com/")).toBe("example.com");
  });

  test("a real path stays", () => {
    expect(displayUrl("https://example.com/a/b?c=1")).toBe("example.com/a/b?c=1");
  });

  test("something unparseable is shown as given", () => {
    expect(displayUrl("not a url")).toBe("not a url");
  });
});
