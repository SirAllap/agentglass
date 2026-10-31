/*
 * A pull request of a repository with no checkout (`gh:owner/name`) showed
 * "Ready to merge" with Merge greyed and "nothing here can be changed", though
 * GitHub lets the person merge it. `readOnly` used to feed `busy`, which greys
 * every control; now it greys only what needs a working tree. There is no
 * renderer in the tests, so the rule is asserted against source.
 */
import { describe, expect, test } from "bun:test";
import { githubWillMerge } from "../../shared/mergeReason.ts";

const src = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();
const strip = await Bun.file(new URL("../src/components/RemoteStrip.tsx", import.meta.url)).text();
const code = (s: string) => s.split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join("\n");

describe("a checkout-less pull request", () => {
  test("having no checkout no longer greys every control", () => {
    expect(code(src)).toMatch(/const busy = running \|\| updatingHere;/);
    expect(code(src)).not.toMatch(/const busy = [^\n]*readOnly/);
  });

  test("what needs a working tree is still off, each on its own", () => {
    const c = code(src);
    expect(c).toContain("onApply={readOnly ? undefined : doApplySuggestion}");
    expect(c).toContain("!!unstickGate?.show && !readOnly");
    expect(c).toMatch(/onReviewInTerminal && d && !readOnly/);
  });

  test("what needs a checkout says so, in the panel's own sentence", () => {
    const c = code(src);
    expect(c.split("Needs a checkout of ${away?.repo} on this machine").length - 1).toBe(4);
    expect(c).not.toContain("read-only here");
    expect(c).toContain("disabled={busy || noCheckout} conflicted=");
    expect(c).toContain("noCheckout={readOnly}");
  });

  test("update branch is only a call to GitHub, so it is not held back", () => {
    const c = code(src);
    expect(c).toMatch(/const doUpdateBranch = [^\n]*\n[^\n]*\n\s*if \(!t\) return;/);
    expect(c).toMatch(/disabled=\{!slots\.update\.enabled \|\| busy \|\| updateHeld\(upState\)\}/);
  });

  test("Merge still follows GitHub's own merge state, not the root", () => {
    for (const s of ["CLEAN", "UNSTABLE", "HAS_HOOKS"]) expect(githubWillMerge(s)).toBe(true);
    for (const s of ["BLOCKED", "DIRTY", "DRAFT", "BEHIND", "UNKNOWN"]) expect(githubWillMerge(s)).toBe(false);
    expect(code(src)).toMatch(/const canMerge = githubWillMerge\(d\.mergeState\);/);
    expect(code(src)).toMatch(/const mergeDisabled = busy \|\| !!mergeWork \|\| !!refusal \|\| conflicted \|\| \(!canMerge && !isBehind\);/);
  });

  test("the strip says what is true", () => {
    expect(code(strip)).toContain("merge, branch update, comments and labels work; reviews in a terminal need one");
    expect(code(strip)).not.toContain("nothing runs here");
    expect(code(strip)).not.toContain("you can read and comment");
    expect(code(src)).not.toContain("nothing here can be changed");
  });
});
