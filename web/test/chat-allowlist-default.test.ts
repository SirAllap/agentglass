// Which tools a chat starts able to run without asking.
//
// The list is written to localStorage on every render, so somebody who has
// never opened the field still has a saved copy of whatever the default was on
// the day they first opened the panel. That makes "change the default" a no-op
// for every existing install — which is how "Review with Claude" ended up
// telling the agent to run `gh pr diff` while the allowlist still refused it.
//
// The rule being pinned here: upgrade the previous default, and nothing else.
// A list somebody edited is a decision, and adding a tool to it would be a
// grant nobody issued.
import { describe, expect, test } from "bun:test";
import { ALLOW_DEFAULT, initialAllowed } from "../src/lib/chatAllowlist.ts";

const PREVIOUS = "Read Glob Grep Bash(git status) Bash(git log:*) Bash(git diff:*) Bash(gh pr view:*)";

describe("initialAllowed", () => {
  test("a fresh install gets the current default", () => {
    expect(initialAllowed(null)).toBe(ALLOW_DEFAULT);
  });

  test("the previous default is carried forward", () => {
    expect(initialAllowed(PREVIOUS)).toBe(ALLOW_DEFAULT);
    // Saved with stray whitespace is still the untouched default.
    expect(initialAllowed(`  ${PREVIOUS}  `)).toBe(ALLOW_DEFAULT);
  });

  test("a list somebody edited is left exactly as they left it", () => {
    expect(initialAllowed("Read Grep")).toBe("Read Grep");
    // Even a superset: they removed something on purpose, or added their own.
    expect(initialAllowed(`${PREVIOUS} Bash(make test)`)).toBe(`${PREVIOUS} Bash(make test)`);
    // Deliberately emptied — no tools without asking — stays empty.
    expect(initialAllowed("")).toBe("");
  });

  test("the default grants the two read-only gh verbs the review prompt names", () => {
    expect(ALLOW_DEFAULT).toContain("Bash(gh pr view:*)");
    expect(ALLOW_DEFAULT).toContain("Bash(gh pr diff:*)");
  });

  test("and nothing that writes, comments or merges", () => {
    for (const forbidden of ["Write", "Edit", "gh pr comment", "gh pr review", "gh pr merge", "git push"]) {
      expect(ALLOW_DEFAULT).not.toContain(forbidden);
    }
  });
});
