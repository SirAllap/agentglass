/*
 * Whether a link in a comment is one of this pull request's commits.
 *
 * This rule decides whether to SWALLOW a click, which is why it gets a case per
 * shape. The version it replaced matched `/commits/<hex>` anywhere in any URL,
 * so a link to somebody's CI stopped navigating and quietly switched tabs
 * whenever that hex happened to prefix one of our own commits — found by the
 * error-handling audit, with the offending URLs run through the extracted
 * pattern as its evidence.
 */
import { describe, expect, it } from "bun:test";
import { shaFromHref } from "../src/lib/commitLink.ts";

const REPO = "acme/shop";

describe("a commit link this panel may open", () => {
  it("takes both shapes GitHub writes", () => {
    expect(shaFromHref("https://github.com/acme/shop/commit/abcdef1", REPO)).toBe("abcdef1");
    expect(shaFromHref("https://github.com/acme/shop/pull/12/commits/abcdef1", REPO)).toBe("abcdef1");
    // A bare path in a body means github.com.
    expect(shaFromHref("/acme/shop/commit/abcdef1", REPO)).toBe("abcdef1");
    // GitHub writes them lower-case; a human might not.
    expect(shaFromHref("https://github.com/acme/shop/commit/ABCDEF1", REPO)).toBe("abcdef1");
  });

  it("refuses another host, however the path reads", () => {
    // The reported shape: a CI build URL that happens to contain /commits/<hex>.
    expect(shaFromHref("https://ci.example.com/builds/commits/8c362cc", REPO)).toBeNull();
    expect(shaFromHref("https://evil.example/acme/shop/commit/abcdef1", REPO)).toBeNull();
  });

  it("refuses another repository", () => {
    expect(shaFromHref("https://github.com/other/repo/commit/abcdef1", REPO)).toBeNull();
    // A prefix of the name is not the name.
    expect(shaFromHref("https://github.com/acme/shop-api/commit/abcdef1", REPO)).toBeNull();
  });

  it("refuses a path that merely contains the words", () => {
    expect(shaFromHref("https://github.com/acme/shop/blob/main/x.ts#/commit/deadbee", REPO)).toBeNull();
    expect(shaFromHref("javascript:/commit/deadbee", REPO)).toBeNull();
    expect(shaFromHref("https://github.com/acme/shop/commit/abcdef1/extra", REPO)).toBeNull();
  });

  it("says no when it does not know which repository it is in", () => {
    // A caller with no repository has no business claiming a link is its own.
    expect(shaFromHref("https://github.com/acme/shop/commit/abcdef1", undefined)).toBeNull();
  });

  it("does not read a dot in a repository name as a wildcard", () => {
    expect(shaFromHref("https://github.com/acme/shop.io/commit/abcdef1", "acme/shop.io")).toBe("abcdef1");
    expect(shaFromHref("https://github.com/acme/shopXio/commit/abcdef1", "acme/shop.io")).toBeNull();
  });
});
