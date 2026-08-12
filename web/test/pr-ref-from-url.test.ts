/*
 * Opening the pull request on a card, rather than searching for its number.
 *
 * The card panel lists the pull requests linked to a ClickUp card, and pressing
 * one typed the number into the pull-request panel's filter: "376 matches, 1
 * shown", one more click from the thing you asked for. The panel has had an
 * exact door since the Source-control chip hit the same wall — `openPr(repo,
 * number)`, which selects and opens — and the card row could not use it because
 * it only had the number.
 *
 * It had the URL all along, in the same row, and the URL carries the repository.
 */
import { describe, expect, it } from "bun:test";
import { prRefFromUrl } from "../src/lib/openPrs.ts";

describe("the repository inside a pull request's URL", () => {
  it("is the owner and the name, as the panel spells them", () => {
    // The panel matches this against `repo.nameWithOwner`, so the shape has to
    // be exactly that and not a URL fragment or a path.
    expect(prRefFromUrl("https://github.com/acme/shop-api/pull/482"))
      .toEqual({ repo: "acme/shop-api", number: 482 });
  });

  it("works on an enterprise host, which serves the same path", () => {
    expect(prRefFromUrl("https://git.example.invalid/acme/shop-api/pull/7"))
      .toEqual({ repo: "acme/shop-api", number: 7 });
  });

  it("survives what a real link carries after the number", () => {
    for (const tail of ["", "/", "/files", "#discussion_r1", "?w=1"]) {
      expect(prRefFromUrl(`https://github.com/acme/shop-api/pull/482${tail}`), tail)
        .toEqual({ repo: "acme/shop-api", number: 482 });
    }
  });

  it("says no rather than guessing, and the caller falls back to the search", () => {
    /* A card can state a pull request nobody has linked — that row has no URL
       at all — and an issue link is not a pull request however similar it
       looks. Null is what keeps `openPrs` as the answer for those. */
    for (const url of [
      undefined, null, "", "   ",
      "https://github.com/acme/shop-api/issues/482",
      "https://github.com/acme/shop-api/pull/",
      "https://github.com/acme/shop-api/pull/abc",
      "github.com/acme/shop-api/pull/482",
      "https://app.clickup.com/t/900100/ORBIT-1042",
    ]) {
      expect(prRefFromUrl(url as string | undefined), JSON.stringify(url)).toBeNull();
    }
  });
});
