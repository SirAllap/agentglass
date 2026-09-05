/*
 * "Is this a card id, and does this text refer to that card?"
 *
 * Shared because two sides ask it and must not drift: the panel decides
 * whether Enter is a JUMP or a search, and the server decides whether a sweep
 * has to carry card bodies — which costs seconds, measured at sixteen of them
 * for the first page on a real workspace.
 *
 * The reported case: searching `1042` or `ORBIT-1042` should find that card AND
 * the cards that point at it. His real example is ORBIT-2077, whose body links
 * ORBIT-1042 in a sentence under "How this was found".
 *
 * The interesting half is what must NOT match. A bare number is in dates, in
 * counts, in the middle of a hash, and a search that answers with all of those
 * is one nobody reads twice.
 */
import { describe, expect, test } from "bun:test";
import { cardIdDigits, looksLikeCardId, mentionsCardId } from "../../shared/cardRef.ts";

describe("what looks like a card id", () => {
  test("bare digits and a prefixed id, which is how people type one", () => {
    for (const q of ["1042", "ORBIT-1042", "  ORBIT-2077  ", "orbit-1042"]) {
      expect(looksLikeCardId(q), q).toBe(true);
      expect(cardIdDigits(q), q).toBe(q.trim().replace(/^[A-Za-z][\w]*-/, ""));
    }
  });

  test("but not two digits, and not words", () => {
    // Three digits at least: a page number, a sprint count and "v2" are not
    // cards, and treating them as one turns a filter into a jump.
    for (const q of ["12", "v2", "Pagination Arrows", "ORBIT-", "-1042", "1042 arrows"]) {
      expect(looksLikeCardId(q), q).toBe(false);
      expect(cardIdDigits(q), q).toBeNull();
    }
  });
});

describe("what counts as referring to a card", () => {
  const body = [
    "While fixing the pagination bug on the OC dashboard (ORBIT-1042) and sweeping",
    "the product for other paginated screens. It is a different defect from that one.",
  ].join("\n");

  test("the real case, from the card that reported this", () => {
    expect(mentionsCardId(body, "1042")).toBe(true);
  });

  test("wherever in the line it sits", () => {
    expect(mentionsCardId("ORBIT-1042 is the one", "1042")).toBe(true);
    expect(mentionsCardId("see also ORBIT-1042", "1042")).toBe(true);
    expect(mentionsCardId("[ORBIT-1042](https://app.example/t/abc)", "1042")).toBe(true);
  });

  test("a branch name is a reference too", () => {
    // The boundary rule this borrows from `mentionsCard` in clickup.ts: a
    // hyphen after the number is not a different card, because a branch is
    // literally `fix/ORBIT-1042-pagination`.
    expect(mentionsCardId("merged fix/ORBIT-1042-pagination-arrows", "1042")).toBe(true);
  });

  test("but a longer number is a DIFFERENT card", () => {
    expect(mentionsCardId("ORBIT-10420 is not it", "1042")).toBe(false);
    expect(mentionsCardId("ORBIT-1042x", "1042")).toBe(false);
  });

  test("and a bare number is not a reference at all", () => {
    // The whole reason a prefix is required. Every one of these would come
    // back as "a card that mentions 1042" under a plain substring test.
    for (const text of [
      "the sweep scanned 1042 rows",
      "hash 3f1042ab",
      "on 2026-09-17 at 01042",
      "1042",
    ]) expect(mentionsCardId(text, "1042"), text).toBe(false);
  });

  test("nothing to search, and nothing to search for", () => {
    expect(mentionsCardId("", "1042")).toBe(false);
    expect(mentionsCardId("ORBIT-1042", "")).toBe(false);
  });
});
