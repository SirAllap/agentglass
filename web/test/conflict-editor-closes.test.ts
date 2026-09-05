/**
 * The three-way editor must close when the merge it is editing ends.
 *
 * `blockFile` — the file open in the conflict editor — was only ever cleared
 * by its own close button or by applying a resolution. So a merge that ended
 * UNDERNEATH it left the editor open over a file that no longer conflicts:
 * an abort, a branch change, or somebody resolving it in a terminal.
 *
 * Reported after a `git merge --abort`: "it just stays like this… and it no
 * longer matters which branch I switch to, it stays stuck". It is a real stuck state rather
 * than a cosmetic one — the editor is drawn INSTEAD of the changes list, so
 * the panel stops being usable for anything else until the tab reloads.
 */
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";

const SRC = readFileSync(new URL("../src/components/GitPanel.tsx", import.meta.url), "utf8");

describe("when the merge ends", () => {
  /** The effect that reacts to a tree with no merge in it. */
  function theEffect(): string {
    const at = SRC.indexOf('mergeState === "clean") {');
    expect(at, "the merge-state effect moved").toBeGreaterThan(-1);
    return SRC.slice(at, SRC.indexOf("return;", at));
  }

  test("everything the merge put on screen is taken back off", () => {
    const e = theEffect();
    for (const cleared of ["setConflicts([])", "setMerge(null)", "setBlockFile(null)", "setBlocks(null)"]) {
      expect(e, `${cleared} is left behind when the merge ends`).toContain(cleared);
    }
  });

  test("the picks go too — a stale answer must not survive into the next merge", () => {
    /* Picks are per-conflict-block. Carrying them into a different merge is
       worse than losing them: they would pre-answer questions nobody asked. */
    expect(theEffect()).toContain("setPicks({})");
  });

  test("and the error from the last attempt does not outlive it", () => {
    expect(theEffect()).toContain("setBlockErr(null)");
  });

  test("the close button still works on its own", () => {
    /* Clearing on merge-end must not be the ONLY way out: somebody may close
       the editor while the merge is still live. */
    expect(SRC).toContain('title="Back to the changes"');
  });
});
