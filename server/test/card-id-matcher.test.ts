/*
 * ONE DEFINITION OF "A CARD ID".
 *
 * The pull request decorator used to carry its own pattern, one digit allowed,
 * which took `utf-8` and `gpt-4` for cards; the panel's jump carried another,
 * three digits. Both now read shared/cardRef.ts, and the digit floor is an
 * argument rather than a copy.
 */
import { describe, expect, it } from "bun:test";
import { cardIdIn, looksLikeCardId } from "../../shared/cardRef.ts";
import { readTaskRef } from "../../shared/taskref.ts";

describe("looksLikeCardId with a digit floor", () => {
  it("keeps three digits as the default", () => {
    expect(looksLikeCardId("ORBIT-1042")).toBe(true);
    expect(looksLikeCardId("ORBIT-42")).toBe(false);
  });

  it("takes the floor from the caller", () => {
    expect(looksLikeCardId("ORBIT-42", { minDigits: 2 })).toBe(true);
    expect(looksLikeCardId("ORBIT-4", { minDigits: 2 })).toBe(false);
    expect(looksLikeCardId("1042", { minDigits: 5 })).toBe(false);
  });
});

describe("the id inside a branch or a title", () => {
  it("finds a card said the way people say one", () => {
    expect(cardIdIn("fix/ORBIT-1042-pagination")).toBe("ORBIT-1042");
    expect(cardIdIn("ORBIT-1042: round it")).toBe("ORBIT-1042");
  });

  it("does not take a version string for a card", () => {
    for (const t of ["fix/utf-8-decode", "chore/gpt-4-prompt", "feature/no-id-here"]) {
      expect(cardIdIn(t), t).toBeNull();
    }
  });

  it("answers the same question as the whole-string check", () => {
    for (const id of ["ORBIT-1042", "ab-12", "Acme-7654321"]) {
      expect(looksLikeCardId(id, { minDigits: 2 }), id).toBe(true);
      expect(cardIdIn(id), id).toBe(id);
    }
  });
});

describe("the two matchers differ on purpose", () => {
  it("a lower-case or digit-led prefix is a lookup candidate here and no chip there", () => {
    // `release/v2-1409` is not worth a chip on any tracker, but this one is only
    // ever followed by a board lookup, which rejects it.
    expect(cardIdIn("release/v2-1409")).toBe("v2-1409");
    expect(readTaskRef({ headRefName: "release/v2-1409" })).toBeNull();
  });
});

describe("one id wins, whichever screen reads it", () => {
  const reach = { keys: ["ORBIT"], site: "https://acme.atlassian.net" };

  it("reads the Jira key in the branch before a look-alike id in the title", () => {
    const r = readTaskRef({ headRefName: "orbit-7-retry", title: "Fix CVE-2026-1234 in parser" }, reach);
    expect(r).toMatchObject({ label: "ORBIT-7", query: "ORBIT-7", from: "branch" });
  });

  it("says `title` when the title is where the id came from", () => {
    const r = readTaskRef({ headRefName: "retry-export", title: "Port ORBIT-12 changes" }, reach);
    expect(r).toMatchObject({ label: "ORBIT-12", from: "title" });
  });

  it("a key that is also a common word is not a card when its number continues into more numbers", () => {
    const common = { keys: ["API", "ORBIT"], site: "https://acme.atlassian.net" };
    expect(readTaskRef({ headRefName: "api-3-1-bump", title: "Bump the client" }, common)).toBeNull();
    expect(readTaskRef({ headRefName: "api-3-bump", title: "Bump the client" }, common)).toMatchObject({ label: "API-3" });
  });
});
