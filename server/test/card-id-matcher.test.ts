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
