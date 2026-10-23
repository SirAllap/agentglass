import { describe, expect, test } from "bun:test";
import { previewParts, sizeWords } from "../src/lib/reviewPreview.ts";

describe("the prompt preview", () => {
  test("fills the demo pull request in and marks what it filled", () => {
    expect(previewParts("Pull request #{number} of {repo}.", "reviewing")).toEqual([
      { text: "Pull request #", filled: false }, { text: "1042", filled: true },
      { text: " of ", filled: false }, { text: "acme/orbit", filled: true }, { text: ".", filled: false },
    ]);
  });

  test("a placeholder it has no value for stays as written, and so does a stray brace", () => {
    const text = previewParts("{nope} and {} and {number}", "reviewing").map((p) => p.text).join("");
    expect(text).toBe("{nope} and {} and 1042");
  });

  test("a conflict prompt has its own words: files, worktree, base", () => {
    expect(previewParts("{files} on {base}", "conflicts").map((p) => p.text).join("")).toBe("src/sync.ts\nsrc/net.ts on main");
    // `{since}` is a review word: in a conflict prompt it is not filled.
    expect(previewParts("{since}", "conflicts")).toEqual([{ text: "{since}", filled: false }]);
  });

  test("nothing to preview is an empty list, not one empty part", () => {
    expect(previewParts("", "reviewing")).toEqual([]);
  });

  test("the size line rounds tokens up", () => {
    expect(sizeWords("")).toBe("0 chars · ~0 tokens");
    expect(sizeWords("x".repeat(1240))).toBe("1,240 chars · ~336 tokens");
  });
});
