/*
 * What a section heading in the Diff view says about who did the work.
 *
 * One live author: the heading names the agent writing there — that is what
 * makes a list grouped by checkout read as per-agent at all. More than one: the
 * heading has to say so rather than naming whichever of them it saw first. A
 * file more than one of them edited is the part that cannot be split by
 * author, so the row itself says whose it is.
 */
import { describe, expect, test } from "bun:test";
import { authorsIndex, headingAuthors, rowAuthorsTitle, joinNames, sectionAuthors } from "../src/lib/treeAuthors.ts";
import type { TreeAuthorsInfo } from "../../shared/types.ts";

const REPO = "/home/dev/code/orbit";
const WT = "/home/dev/code/orbit-WEB-1042";
const tree = (root: string, names: string[], overlap: { path: string; sessions: string[] }[] = []): TreeAuthorsInfo =>
  ({ root, sessions: names.map((n, i) => ({ id: `s${i}`, name: n })), overlap });
/** A row as the list keys it: `ChangeRow.key` is documented in
 *  shared/types.ts as root, NUL, relative path. Written from that contract,
 *  not from treeAuthors.ts, so the two are at least stated twice. */
const rowKey = (repoRoot: string, path: string) => [repoRoot, path].join(String.fromCharCode(0));

describe("headingAuthors", () => {
  test("one author: named, and not flagged", () => {
    const h = headingAuthors(tree(WT, ["export retries"]), 0);
    expect(h.shared).toBe(false);
    expect(h.text).toBe("export retries is writing here");
  });

  test("two authors: flagged as shared, both named, and the overlap counted", () => {
    const h = headingAuthors(tree(REPO, ["export retries", "calendar sync"],
      [{ path: "src/app.ts", sessions: ["export retries", "calendar sync"] }]), 1);
    expect(h.shared).toBe(true);
    expect(h.text).toBe("shared · 2 sessions");
    expect(h.title).toContain("export retries and calendar sync");
    expect(h.title).toContain("1 file");
    expect(h.title).toContain("approximate");
  });

  test("shared without an overlapping file says the files are still apart", () => {
    const h = headingAuthors(tree(REPO, ["a", "b"]), 0);
    expect(h.shared).toBe(true);
    expect(h.title).toContain("No file here has been edited by more than one");
  });

  test("the count is the section's marked rows, not every file they ever both touched", () => {
    // Two files both edited; one has since been committed and left the list.
    const t = tree(REPO, ["a", "b"], [{ path: "x.ts", sessions: ["a", "b"] }, { path: "y.ts", sessions: ["a", "b"] }]);
    expect(headingAuthors(t, 1).title).toContain("1 file here has");
  });
});

describe("authorsIndex", () => {
  test("rows are keyed as the list keys them: root, NUL, relative path", () => {
    const ix = authorsIndex([tree(REPO, ["a", "b", "c"], [{ path: "src/app.ts", sessions: ["a", "c"] }]), tree(WT, ["d"])]);
    expect(ix.byRoot.get(WT)?.sessions[0]?.name).toBe("d");
    // Exactly the two that edited it, not every author of the tree.
    expect(ix.byRow.get(rowKey(REPO, "src/app.ts"))).toEqual(["a", "c"]);
    // A file only one of them touched is not marked, and neither is the other tree.
    expect(ix.byRow.get(rowKey(WT, "src/app.ts"))).toBeUndefined();
  });

  test("a section is named only when it is a checkout — never a day or a folder", () => {
    const ix = authorsIndex([tree(REPO, ["a"])]);
    expect(sectionAuthors(ix, "worktree", REPO)?.sessions[0]?.name).toBe("a");
    expect(sectionAuthors(ix, "time", REPO)).toBeUndefined();
    expect(sectionAuthors(ix, "folder", REPO)).toBeUndefined();
  });

  test("an older server that sends nothing is nobody, not an error", () => {
    const ix = authorsIndex(undefined);
    expect(ix.byRoot.size).toBe(0);
    expect(ix.byRow.size).toBe(0);
  });
});

test("joinNames reads as a sentence", () => {
  expect(joinNames(["a"])).toBe("a");
  expect(joinNames(["a", "b"])).toBe("a and b");
  expect(joinNames(["a", "b", "c"])).toBe("a, b and c");
});

test("the row's tooltip names every author and says the diff is theirs together", () => {
  const t = rowAuthorsTitle(["a", "b"]);
  expect(t).toContain("a and b");
  expect(t).toContain("together");
});
