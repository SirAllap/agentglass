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
const tree = (root: string, names: string[], overlap: string[] = []): TreeAuthorsInfo =>
  ({ root, branch: "main", sessions: names.map((n, i) => ({ id: `s${i}`, name: n })), overlap });

describe("headingAuthors", () => {
  test("one author: named, and not flagged", () => {
    const h = headingAuthors(tree(WT, ["export retries"]));
    expect(h.shared).toBe(false);
    expect(h.text).toBe("export retries is writing here");
  });

  test("two authors: flagged as shared, both named, and the overlap counted", () => {
    const h = headingAuthors(tree(REPO, ["export retries", "calendar sync"], ["src/app.ts"]));
    expect(h.shared).toBe(true);
    expect(h.text).toBe("shared · 2 sessions");
    expect(h.title).toContain("export retries and calendar sync");
    expect(h.title).toContain("1 file");
    expect(h.title).toContain("approximate");
  });

  test("shared without an overlapping file says the files are still apart", () => {
    const h = headingAuthors(tree(REPO, ["a", "b"]));
    expect(h.shared).toBe(true);
    expect(h.title).toContain("No file has been edited by more than one");
  });
});

describe("authorsIndex", () => {
  test("rows are keyed as the list keys them: root, NUL, relative path", () => {
    const ix = authorsIndex([tree(REPO, ["a", "b"], ["src/app.ts"]), tree(WT, ["c"])]);
    expect(ix.byRoot.get(WT)?.sessions[0]?.name).toBe("c");
    expect(ix.byRow.get(`${REPO}\0src/app.ts`)).toEqual(["a", "b"]);
    // A file only one of them touched is not marked, and neither is the other tree.
    expect(ix.byRow.get(`${WT}\0src/app.ts`)).toBeUndefined();
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
