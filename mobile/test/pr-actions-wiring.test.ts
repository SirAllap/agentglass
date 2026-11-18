/*
 * Where the board sheet's PR actions go. Asserted against source (there is no
 * renderer here): each row reaches the server route the desktop calls, or the
 * phone sheet that already does it, and the merge lock is read before Merge is
 * drawn.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const src = (...p: string[]): string => readFileSync(join(import.meta.dir, "..", ...p), "utf8");
const strip = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("the actions sheet", () => {
  const sheet = strip(src("src", "review", "PrActionsSheet.tsx"));

  test("a verdict and its note go in one review call", () => {
    expect(sheet).toContain('"/prs/review-with"');
  });

  test("a comment goes to the desktop's comment route, and never empty", () => {
    expect(sheet).toContain('"/prs/comment"');
    expect(sheet).toMatch(/if \(!host \|\| !mayWrite \|\| !note\.trim\(\)\) return;/);
  });

  test("the merge lock is read when the sheet opens and feeds the rows", () => {
    expect(sheet).toContain("/prs/merge-lock?root=");
    expect(sheet).toContain("mergeLock: lock");
  });

  test("a row the lock holds cannot be pressed", () => {
    expect(sheet).toContain(`disabled={busy || !!row.off || (row.id === "reviewers" && !!blocked)}`);
  });

  test("review, watch and merge hand off to their own sheets", () => {
    expect(sheet).toContain('if (id === "reviewers") { onClose(); onReviewers(); return; }');
    expect(sheet).toContain('if (id === "watch") { onClose(); onWatch?.(); return; }');
    expect(sheet).toContain('if (id === "merge") { onClose(); onMerge?.(); return; }');
  });
});

describe("the board", () => {
  const board = strip(src("app", "(tabs)", "prs.tsx"));

  test("Merge opens the pull request with its merge sheet up, as the card's footer does", () => {
    expect(board).toContain('onMerge={() => { if (acting) void cardAction(acting, "merge"); }}');
  });

  test("Request a review opens the pull request with the reviewers sheet up", () => {
    expect(board).toMatch(/reviewers: "1" \} \}\);/);
  });

  test("Tell me when uses the watch sheet the inbox and the pull request use", () => {
    expect(board).toContain("<WatchRuleSheet");
    expect(board).toContain("onWatch={() => { if (acting) setWatchFor(acting); }}");
  });
});

describe("the pull request", () => {
  const pr = strip(src("app", "pr", "[number].tsx"));

  test("reviewers=1 opens the reviewers sheet once, and only for a phone that may write", () => {
    expect(pr).toContain('if (wantReviewers !== "1") return;');
    expect(pr).toContain("router.setParams({ reviewers: undefined });");
    expect(pr).toContain("if (mayWrite) setReviewersOpen(true);");
  });
});
