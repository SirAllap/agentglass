/*
 * A branch on one line.
 *
 * The row is fixed height, so a label longer than the space would either wrap or
 * push the name aside. Every cut is deterministic, keeps the leaf when there is
 * one (the part that tells two branches apart is after the last `/`), and the
 * full value goes to `title` and the checkbox's accessible name.
 */
import { describe, expect, test } from "bun:test";
import { BRANCH_MAX, branchLabel } from "../src/lib/setupRepos.ts";

const long = "feature/acme-ORBIT-1042-the-canvas-board-rewrite";
const late = "acme/orbit/feature/a-canvas-board";
const plain = "release-candidate-2026-11-01-canvas";

describe("the cut", () => {
  test("a branch that fits is left alone", () => {
    expect(branchLabel("main")).toBe("main");
    expect(branchLabel("feat/canvas-board")).toBe("feat/canvas-board");
  });

  test("every long branch fits one line", () => {
    for (const b of [long, late, plain]) {
      expect(branchLabel(b).length).toBeLessThanOrEqual(BRANCH_MAX);
      expect(branchLabel(b)).toContain("…");
    }
  });

  test("a section to the right of the cut is kept, because that is what tells two branches apart", () => {
    const cut = branchLabel(late);
    expect(cut.endsWith("a-canvas-board")).toBe(true);
    expect(cut.startsWith("…/")).toBe(true);
  });

  test("a branch with no slash is cut in its middle, so both ends still read", () => {
    const cut = branchLabel(plain);
    expect(cut.startsWith("release")).toBe(true);
    expect(cut.endsWith("canvas")).toBe(true);
    expect(cut).not.toContain("/");
  });

  test("the same input cuts the same way, twice", () => {
    expect(branchLabel(long)).toBe(branchLabel(long));
    expect(branchLabel(long, long.length)).toBe(long);
  });

  test("a name shorter than the budget is never cut into an ellipsis", () => {
    expect(branchLabel("x".repeat(BRANCH_MAX))).toBe("x".repeat(BRANCH_MAX));
  });
});
