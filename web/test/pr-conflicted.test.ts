/*
 * Whether the pull request panel treats a branch as conflicted — which is what
 * takes "Update branch" away and puts "Resolve conflicts" in its place.
 *
 * Three witnesses, and they disagree in practice. GitHub's `mergeable` is
 * computed lazily and answers UNKNOWN until somebody asks twice. The panel's
 * own merge of the two trees names the files, unless the fetch behind it
 * failed. And "Update branch" itself: GitHub attempts the merge, and a refusal
 * over a conflict is the freshest answer there is — the button was on screen
 * because neither of the other two had said "conflict" yet, and pressing it
 * used to end in an error with nothing to press next.
 */
import { describe, expect, it } from "bun:test";
import { prConflicted } from "../src/lib/updateBranch.ts";

const files = (list: string[], stale = false) => ({ files: list, stale });

describe("an update refused over a conflict", () => {
  it("counts as a conflict when GitHub had not worked it out yet", () => {
    expect(prConflicted("UNKNOWN", null, true)).toBe(true);
    expect(prConflicted("MERGEABLE", null, true)).toBe(true);
  });

  it("counts even when the file list came from a stale fetch", () => {
    expect(prConflicted("MERGEABLE", files(["web/src/lib/thing.ts"], true), true)).toBe(true);
  });

  it("outranks a clean merge here — GitHub just tried the merge and refused it", () => {
    expect(prConflicted("MERGEABLE", files([]), true)).toBe(true);
  });
});

describe("without a refusal, what it did before", () => {
  it("follows GitHub's verdict", () => {
    expect(prConflicted("CONFLICTING", null, false)).toBe(true);
    expect(prConflicted("MERGEABLE", null, false)).toBe(false);
  });

  it("follows the files git found, over GitHub's UNKNOWN", () => {
    expect(prConflicted("UNKNOWN", files(["a.ts"]), false)).toBe(true);
  });

  it("does not let a stale file list take buttons away", () => {
    expect(prConflicted("MERGEABLE", files(["a.ts"], true), false)).toBe(false);
  });

  it("lets a fresh clean merge overrule GitHub's lagging CONFLICTING", () => {
    expect(prConflicted("CONFLICTING", files([]), false)).toBe(false);
  });
});

/*
 * The checks line appends "no conflicts with <base>" on GitHub's MERGEABLE.
 * After a refusal, or with git naming the files, that sat directly above
 * Resolve conflicts — the panel saying both things at once. The claim follows
 * the panel's own verdict, not GitHub's alone.
 */
const panel = await Bun.file(new URL("../src/components/PrPanel.tsx", import.meta.url)).text();

describe("the checks line", () => {
  it("claims no conflicts only when the panel does not think there is one", () => {
    // The calls that pass a base to name — the others make no such claim.
    const calls = (panel.match(/checksLine\(c, [^)]*\)/g) ?? []).filter((x) => x.includes("MERGEABLE"));
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toContain("!conflicted");
  });
});
