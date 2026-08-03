// Folding a long message. The case is a pasted prompt — a review brief with its
// rules and a block of JSON — which rendered whole takes the panel and pushes
// the reply off the bottom of it. What matters: ordinary turns are never
// folded, the preview keeps the top rather than a summary, and the control can
// say how much it is hiding.
import { describe, expect, test } from "bun:test";
import {
  FOLD_CHARS, FOLD_LINES, foldPreview, hiddenLineCount, isLongMessage,
} from "../src/lib/chatFold.ts";

const lines = (n: number, word = "line") =>
  Array.from({ length: n }, (_, i) => `${word} ${i + 1}`).join("\n");

describe("isLongMessage", () => {
  test("an ordinary turn is left alone", () => {
    expect(isLongMessage("Can you rebase this onto main?")).toBe(false);
    expect(isLongMessage(lines(FOLD_LINES))).toBe(false);
  });

  test("a pasted brief is folded", () => {
    expect(isLongMessage(lines(FOLD_LINES + 1))).toBe(true);
    expect(isLongMessage(lines(400))).toBe(true);
  });

  test("prose with few newlines still wraps to many rows, so length counts too", () => {
    expect(isLongMessage("x".repeat(FOLD_CHARS + 1))).toBe(true);
    expect(isLongMessage("x".repeat(FOLD_CHARS - 1))).toBe(false);
  });

  test("nothing is not long", () => {
    expect(isLongMessage("")).toBe(false);
    expect(isLongMessage(undefined)).toBe(false);
    expect(isLongMessage(null)).toBe(false);
  });

  test("counting stops early rather than splitting a 100 KB message", () => {
    // Not observable from outside beyond it returning at all — this is here so
    // the early return is not "simplified" back into a split() later.
    const huge = lines(50_000);
    expect(isLongMessage(huge)).toBe(true);
  });
});

describe("foldPreview", () => {
  test("keeps the top, which is the part that says what it is", () => {
    expect(foldPreview(lines(100), 3)).toBe("line 1\nline 2\nline 3");
  });

  test("a message shorter than the fold comes back whole", () => {
    expect(foldPreview("a\nb", 5)).toBe("a\nb");
  });

  test("does not appear to cut in the middle of nothing", () => {
    // Trailing blanks inside the window are dropped, so the fade does not land
    // under two empty rows.
    expect(foldPreview("a\n\n\n\nb", 3)).toBe("a");
  });

  test("a single line survives", () => {
    expect(foldPreview("only", 3)).toBe("only");
  });
});

describe("hiddenLineCount", () => {
  test("says what opening it costs", () => {
    expect(hiddenLineCount(lines(100), 14)).toBe(86);
  });

  test("never negative when the message is shorter than the window", () => {
    expect(hiddenLineCount("a\nb", 14)).toBe(0);
  });
});
