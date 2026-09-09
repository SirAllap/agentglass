/*
 * What changed inside a line, and — mostly — when not to claim anything did.
 *
 * The value of this is a reader not playing spot-the-difference on eleven-point
 * monospace. The RISK of it is a highlight that marks the wrong half of a line,
 * which is worse than the two plain bands it replaced: a mark is read as a
 * fact, and a wrong fact about a diff sends somebody looking at code that did
 * not change. So most of what is pinned here is a refusal.
 */
import { describe, expect, test } from "bun:test";
import { inlineSpans, pairsIn, tokens } from "../src/model/tokens.ts";
import type { DiffLine } from "../src/model/diffLines.ts";

/** The changed text of a side, which is the whole question a reader has. */
const marked = (spans: { text: string; changed: boolean }[] | undefined): string =>
  (spans ?? []).filter((s) => s.changed).map((s) => s.text).join("");

/** And the whole line back, which must be exactly what went in — a renderer
 *  that drops a character is a diff that lies. */
const whole = (spans: { text: string }[] | undefined): string =>
  (spans ?? []).map((s) => s.text).join("");

describe("one identifier renamed", () => {
  const both = inlineSpans(
    "  const answer = await ask(host, `/prs/diff?${query}`);",
    "  const answer = await ask(host, `/prs/detail?${query}`);",
  )!;

  test("only the word that changed is marked, on each side", () => {
    expect(marked(both.before)).toBe("diff");
    expect(marked(both.after)).toBe("detail");
  });

  test("and the line comes back whole", () => {
    expect(whole(both.before)).toBe("  const answer = await ask(host, `/prs/diff?${query}`);");
    expect(whole(both.after)).toBe("  const answer = await ask(host, `/prs/detail?${query}`);");
  });

  test("neighbouring tokens of the same kind are one span", () => {
    // One `<Text>` per token is a paragraph the layout engine measures word by
    // word, on every row of a diff that can be four hundred rows long.
    expect(both.before.length).toBeLessThan(6);
  });
});

describe("an insertion in the middle", () => {
  test("marks what was inserted and nothing either side of it", () => {
    // The case a prefix-only rule gets wrong: it would mark `c, b` and read as
    // though two things moved.
    const both = inlineSpans("foo(a, b)", "foo(a, c, b)")!;
    expect(marked(both.before)).toBe("");
    expect(marked(both.after)).toBe("c, ");
  });

  test("a token appended at the end is the only mark", () => {
    const both = inlineSpans("await load()", "await load(host)")!;
    expect(marked(both.after)).toBe("host");
  });

  test("indentation changing is visible as indentation changing", () => {
    // Whitespace is its own token, so this is not "the whole line changed".
    const both = inlineSpans("  return null;", "      return null;")!;
    expect(marked(both.before)).toBe("  ");
    expect(marked(both.after)).toBe("      ");
  });
});

describe("what it refuses to mark", () => {
  test("two lines that share almost nothing are not an edit of each other", () => {
    // A line that went and a line that came. Marking them token by token marks
    // nearly everything, which is the same as marking nothing and costs the
    // reader a second to work out.
    expect(inlineSpans("import { readFileSync } from 'node:fs';", "export const TAP = 44;")).toBeNull();
  });

  test("identical lines have nothing to say", () => {
    expect(inlineSpans("same", "same")).toBeNull();
  });

  test("an empty side is not a rewrite", () => {
    // A line emptied or a line born is a deletion and an addition; the bands
    // already say so.
    expect(inlineSpans("", "something")).toBeNull();
    expect(inlineSpans("something", "")).toBeNull();
  });
});

describe("a line with no length limit", () => {
  const under = (name: string, before: string, after: string): void => {
    test(name, () => {
      const started = performance.now();
      inlineSpans(before, after);
      // Loose on purpose. It is not a benchmark — it is the difference between
      // a scroll and a phone that stops answering, and a tight number here
      // would fail on a busy runner while proving nothing extra.
      expect(performance.now() - started).toBeLessThan(500);
    });
  };

  const long = "x".repeat(4000);
  under("a minified line that changed at the end", `${long} a`, `${long} b`);
  under("two long lines that differ throughout",
    Array.from({ length: 2000 }, (_, i) => `t${i}`).join(" "),
    Array.from({ length: 2000 }, (_, i) => `u${i}`).join(" "));
  under("a long line with a long common middle",
    `head ${long} tail`, `HEAD ${long} TAIL`);

  test("past the bound it is coarse rather than slow", () => {
    // A line the two sides mostly agree on, whose disagreement is longer than
    // the table is allowed to be: the whole middle is marked. Coarser than the
    // truth, and never slower than the reader's patience.
    const same = Array.from({ length: 400 }, (_, i) => `k${i}`).join(" ");
    const a = `${same} ${Array.from({ length: 300 }, (_, i) => `a${i}`).join(" ")} ${same}`;
    const b = `${same} ${Array.from({ length: 300 }, (_, i) => `b${i}`).join(" ")} ${same}`;
    const both = inlineSpans(a, b)!;
    expect(whole(both.before)).toBe(a);
    expect(marked(both.before)).toContain("a0");
    expect(marked(both.before)).not.toContain("k0");
  });

  test("and a pair with nothing much in common is refused before any of that", () => {
    // The similarity floor comes first, so the expensive path is never even
    // reached for two lines that are not an edit of each other.
    const a = Array.from({ length: 300 }, (_, i) => `a${i}`).join(" ");
    const b = Array.from({ length: 300 }, (_, i) => `b${i}`).join(" ");
    expect(inlineSpans(a, b)).toBeNull();
  });
});

describe("which lines are a pair", () => {
  const line = (kind: DiffLine["kind"], text: string): DiffLine =>
    ({ kind, text, oldNo: null, newNo: null });

  test("a run of deletions followed by as many additions", () => {
    const pairs = pairsIn([
      line("ctx", "before"),
      line("del", "one"), line("del", "two"),
      line("add", "ONE"), line("add", "TWO"),
      line("ctx", "after"),
    ]);
    expect([...pairs]).toEqual([[1, 3], [2, 4]]);
  });

  test("uneven runs are a deletion and an insertion, not edits", () => {
    // Three lines deleted and one added is not three rewrites, and pairing
    // them would draw a relationship that is not there.
    expect(pairsIn([
      line("del", "a"), line("del", "b"), line("del", "c"),
      line("add", "z"),
    ]).size).toBe(0);
  });

  test("additions with no deletion above them pair with nothing", () => {
    expect(pairsIn([line("ctx", "x"), line("add", "new")]).size).toBe(0);
  });

  test("two separate edits in one hunk are both found", () => {
    const pairs = pairsIn([
      line("del", "a"), line("add", "A"),
      line("ctx", "-"),
      line("del", "b"), line("add", "B"),
    ]);
    expect([...pairs]).toEqual([[0, 1], [3, 4]]);
  });

  test("context between the two runs breaks the pairing", () => {
    // The runs have to be adjacent: a deletion, then unchanged code, then an
    // addition is two separate things that happen to be in one hunk.
    expect(pairsIn([line("del", "a"), line("ctx", "x"), line("add", "A")]).size).toBe(0);
  });
});

describe("tokens", () => {
  test("words, punctuation and runs of space, kept apart", () => {
    expect(tokens("a.b(1)")).toEqual(["a", ".", "b", "(", "1", ")"]);
    expect(tokens("  two words")).toEqual(["  ", "two", " ", "words"]);
  });

  test("an identifier is one token, so a rename is one mark", () => {
    expect(tokens("agentglass_2")).toEqual(["agentglass_2"]);
  });
});
