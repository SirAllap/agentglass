/*
 * The suggestion parser, against the shapes GitHub actually produces.
 *
 * Every case here is one somebody has written into a review comment. The two
 * that matter most are the empty block — which means "delete these lines" and
 * which a falsy check would silently drop — and the outdated thread, where the
 * honest answer is "nowhere to apply this" rather than a line number that now
 * points at something else.
 */
import { describe, expect, test } from "bun:test";
import { suggestionsIn, suggestionRange } from "../../shared/suggestion.ts";

describe("suggestionsIn", () => {
  test("takes the body of a plain block", () => {
    const got = suggestionsIn("Try this:\n\n```suggestion\nconst a = 1;\n```\n");
    expect(got).toEqual([{ text: "const a = 1;" }]);
  });

  test("an empty block is a deletion, not an absence", () => {
    const got = suggestionsIn("Drop it.\n\n```suggestion\n```\n");
    expect(got.length).toBe(1);
    expect(got[0]!.text).toBe("");
  });

  test("keeps every blank and every space inside the block", () => {
    const got = suggestionsIn("```suggestion\nif (x) {\n\n  go();\n}\n```");
    expect(got[0]!.text).toBe("if (x) {\n\n  go();\n}");
  });

  test("finds more than one, in order", () => {
    const got = suggestionsIn("```suggestion\nfirst\n```\nand also\n```suggestion\nsecond\n```");
    expect(got.map((s) => s.text)).toEqual(["first", "second"]);
  });

  test("ignores a fenced block that is not a suggestion", () => {
    expect(suggestionsIn("```ts\nconst a = 1;\n```")).toEqual([]);
    expect(suggestionsIn("```\nplain\n```")).toEqual([]);
  });

  test("an unclosed fence is dropped rather than guessed at", () => {
    expect(suggestionsIn("```suggestion\nhalf a message")).toEqual([]);
  });

  test("strips the fence's own indent and no more", () => {
    // Written inside a list item: the whole block is indented two, and the
    // code's own nesting is four more that must survive.
    const body = "- like so:\n  ```suggestion\n  if (x) {\n      deep();\n  }\n  ```";
    expect(suggestionsIn(body)[0]!.text).toBe("if (x) {\n    deep();\n}");
  });

  test("a longer fence lets a suggestion contain a fence", () => {
    const body = "````suggestion\n```\ninner\n```\n````";
    expect(suggestionsIn(body)[0]!.text).toBe("```\ninner\n```");
  });

  test("says nothing about a body with no block at all", () => {
    expect(suggestionsIn("just a remark")).toEqual([]);
    expect(suggestionsIn("")).toEqual([]);
  });
});

describe("suggestionRange", () => {
  test("one line is a range of itself", () => {
    expect(suggestionRange({ line: 42 })).toEqual({ startLine: 42, line: 42 });
  });

  test("a multi-line thread keeps both ends", () => {
    expect(suggestionRange({ line: 48, startLine: 42 })).toEqual({ startLine: 42, line: 48 });
  });

  test("an outdated thread has nowhere to apply", () => {
    // The lines it was written about are gone. `originalLine` still holds a
    // number, and using it would edit whatever is at that line now.
    expect(suggestionRange({ line: 42, isOutdated: true })).toBe(null);
    expect(suggestionRange({ line: null, isOutdated: true })).toBe(null);
  });

  test("no line is no range", () => {
    expect(suggestionRange({ line: null })).toBe(null);
    expect(suggestionRange({ line: 0 })).toBe(null);
  });

  test("a start after the end is refused rather than swapped", () => {
    // Swapping would apply the change somewhere plausible and wrong. The
    // server refuses this too; agreeing with it here saves a round trip.
    expect(suggestionRange({ line: 10, startLine: 20 })).toBe(null);
  });
});
