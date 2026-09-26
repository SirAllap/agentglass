/*
 * Source control opens the checkout the terminal was looking at.
 *
 * It opened `found[0]`, the first checkout the machine listed, whichever pane
 * it came from — on a machine working a worktree per pull request, another
 * branch drawn under the name of this one.
 */
import { describe, expect, test } from "bun:test";
import { branchLookup, checkoutFor } from "../src/model/checkout.ts";

const roots = ["/work/orbit", "/work/orbit-wt/feat-search", "/work/lantern"];
const repos = await Bun.file(new URL("../app/(tabs)/repos.tsx", import.meta.url)).text();
const terminal = await Bun.file(new URL("../app/(tabs)/terminal.tsx", import.meta.url)).text();

describe("checkoutFor", () => {
  test("the root itself", () => {
    expect(checkoutFor("/work/lantern", roots)).toBe("/work/lantern");
  });
  test("a directory below it, and the deepest root wins", () => {
    expect(checkoutFor("/work/orbit-wt/feat-search/src", roots)).toBe("/work/orbit-wt/feat-search");
    expect(checkoutFor("/work/orbit/src/ui", roots)).toBe("/work/orbit");
  });
  test("a sibling that shares a prefix is not inside", () => {
    expect(checkoutFor("/work/orbital", roots)).toBe("/work/orbital");
  });
});

describe("the screens, read", () => {
  test("the terminal passes the pane's directory", () => {
    expect(terminal).toMatch(/pathname: "\/repos", params: \{ root: open\.where \}/);
  });
  test("Source control reads it rather than taking the first checkout", () => {
    expect(repos).toContain("useLocalSearchParams<{ root?: string }>()");
    expect(repos).toContain("checkoutFor(asked, roots)");
  });
});

describe("branchLookup", () => {
  test("a named branch is looked up", () => {
    expect(branchLookup("feat-search")).toEqual({ ask: true, branch: "feat-search" });
  });
  test("a detached HEAD has no branch, and says so instead of asking GitHub", () => {
    const r = branchLookup("(detached)");
    expect(r.ask).toBe(false);
    expect(r.ask === false && r.reason).toMatch(/no branch/i);
  });
  test("no branch read yet is not an answer", () => {
    expect(branchLookup(undefined)).toEqual({ ask: false, reason: null });
  });
});
