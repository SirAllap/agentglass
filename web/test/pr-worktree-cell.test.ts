/*
 * "Where is this branch on my machine?" — and the third answer.
 *
 * Asked for after using the terminal's own header, which has carried the worktree
 * with Git and Diff beside it for a while: the pull request named the branch and
 * said nothing about the checkout it is in.
 *
 * The rule with teeth is the one about not knowing yet. `localHead` arrives a beat
 * after the pull request does, and "no worktree has this branch" drawn during that
 * beat is the header asserting the opposite of the truth about a branch the reader
 * has open in the next tab. So there are three answers, and the empty one is not
 * the negative one.
 */
import { describe, expect, it } from "bun:test";
import type { PrLocalHead } from "../../shared/types.ts";
import { folderOf, wtCell, wtCellTitle } from "../src/lib/prWorktreeCell.ts";

const head = (over: Partial<PrLocalHead> = {}): PrLocalHead => ({
  branch: "orbit-1042-usage-counter", exists: true, ahead: 0, behind: 0, dirty: false,
  sync: "clean" as PrLocalHead["sync"], ...over,
});

describe("wtCell", () => {
  it("says nothing at all until the answer is in", () => {
    expect(wtCell(null).kind).toBe("unknown");
    expect(wtCell(undefined).kind).toBe("unknown");
    expect(wtCellTitle(null)).toBe("Reading which worktree has this branch");
  });

  it("answers 'nowhere' only when it has really been answered", () => {
    expect(wtCell(head()).kind).toBe("none");
    expect(wtCellTitle(head())).toContain("is not checked out in any worktree");
  });

  it("names the folder, and keeps the full path for the tooltip", () => {
    const cell = wtCell(head({ worktree: "/home/dev/code/orbit-1042" }));
    expect(cell).toEqual({ kind: "here", root: "/home/dev/code/orbit-1042", folder: "orbit-1042", dirty: false });
    expect(wtCellTitle(head({ worktree: "/home/dev/code/orbit-1042" })))
      .toBe("orbit-1042-usage-counter is checked out in /home/dev/code/orbit-1042");
  });

  it("carries the dirty tree, because that is what stops you pulling into it", () => {
    const cell = wtCell(head({ worktree: "/home/dev/code/orbit-1042", dirty: true }));
    expect(cell).toMatchObject({ dirty: true });
    expect(wtCellTitle(head({ worktree: "/home/dev/code/orbit-1042", dirty: true })))
      .toContain("uncommitted changes");
  });

  // A path that is there and empty is an absence. Drawn as "here" it would be a
  // blank folder name with two live buttons pointing at the filesystem root.
  it("an empty path is nowhere, not a nameless somewhere", () => {
    expect(wtCell(head({ worktree: "" })).kind).toBe("none");
    expect(wtCell(head({ worktree: "   " })).kind).toBe("none");
  });

  it("folderOf takes the last segment, trailing slash or not", () => {
    expect(folderOf("/home/dev/code/orbit-1042/")).toBe("orbit-1042");
    expect(folderOf("orbit-1042")).toBe("orbit-1042");
  });
});
