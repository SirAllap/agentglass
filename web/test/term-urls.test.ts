/*
 * A URL printed in a sentence ends where the sentence does. The terminal's URL
 * addon stops before `. , : ! ? ) ] > ' "` but not before `;`, and it cannot
 * read a URL that has a bracket pair in it, so the regex is ours.
 */
import { describe, expect, test } from "bun:test";
import { pathCandidates } from "../src/lib/termPaths.ts";
import { TERM_URL } from "../src/lib/termUrls.ts";

const urls = (line: string) => [...line.matchAll(new RegExp(TERM_URL.source, "g"))].map((m) => m[0]);

describe("a URL in a sentence", () => {
  test("loses the punctuation that ends the sentence", () => {
    for (const end of [".", ",", ";", ":", "!", "?", ")", "]", "}", "'", '"', ">", ").", "),", ");"]) {
      expect(urls(`see https://acme.test/x/y${end} next`), end).toEqual(["https://acme.test/x/y"]);
    }
  });

  test("keeps a trailing slash, a query and a fragment", () => {
    expect(urls("go https://acme.test/x/ now")).toEqual(["https://acme.test/x/"]);
    expect(urls("go https://acme.test/x?a=1&b=2#top.")).toEqual(["https://acme.test/x?a=1&b=2#top"]);
  });

  test("keeps a bracket pair that belongs to the URL, drops one that does not", () => {
    expect(urls("see https://acme.test/wiki/Orbit_(ship).")).toEqual(["https://acme.test/wiki/Orbit_(ship)"]);
    expect(urls("see (https://acme.test/wiki/Orbit_(ship)).")).toEqual(["https://acme.test/wiki/Orbit_(ship)"]);
    expect(urls("see (https://acme.test/x),")).toEqual(["https://acme.test/x"]);
  });

  test("finds two in one line", () => {
    expect(urls("a https://acme.test/a; b https://acme.test/b.")).toEqual(["https://acme.test/a", "https://acme.test/b"]);
  });
});

describe("a path at the end of a sentence", () => {
  test("is the path alone, with its line and column suffix gone", () => {
    const texts = (l: string) => pathCandidates(l).map((c) => c.text);
    for (const end of [".", ",", ";", ":", "!", ")", "]", "}", "'", '"', ">", ").", ":12.", ":12:3:"]) {
      expect(texts(`wrote ~/notes/notes-2026-10-20.md${end} next`), end).toEqual(["~/notes/notes-2026-10-20.md"]);
    }
    expect(texts("wrote ~/notes/")).toEqual(["~/notes/"]);
  });
});
